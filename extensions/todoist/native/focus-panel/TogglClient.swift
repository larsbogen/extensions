import Foundation
import Security
import LocalAuthentication

protocol TogglCredentials {
    func token(accountID: Int64) throws -> String
    func save(token: String, accountID: Int64) throws
}

struct TogglKeychain: TogglCredentials {
    // The service is stable across builds; access remains governed by macOS Keychain.
    let service = "local.todoist.focus-panel.toggl"
    func query(_ accountID: Int64) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: String(accountID)]
    }
    func token(accountID: Int64) throws -> String {
        var request = query(accountID)
        // A background stop must not block the main queue on a Keychain dialog.
        let context = LAContext()
        context.interactionNotAllowed = true
        request[kSecUseAuthenticationContext as String] = context
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &value) == errSecSuccess,
              let data = value as? Data, let token = String(data: data, encoding: .utf8) else {
            throw TogglError.credentials
        }
        return token
    }
    func save(token: String, accountID: Int64) throws {
        let attributes = [kSecValueData as String: Data(token.utf8)]
        let status = SecItemUpdate(query(accountID) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var request = query(accountID)
            request.merge(attributes) { _, new in new }
            request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(request as CFDictionary, nil) == errSecSuccess else { throw TogglError.credentials }
        } else if status != errSecSuccess { throw TogglError.credentials }
    }
}

enum TogglError: Error {
    case credentials
    case storage
    case http(Int, Double?)
    case network(Bool)
    case invalidResponse
    case quota(Double)

    var uncertainWrite: Bool {
        switch self {
        case .network(let uncertain): return uncertain
        case .invalidResponse: return true
        case .http(let status, _): return status >= 500 || status == 408 || (300..<400).contains(status)
        default: return false
        }
    }
    var needsAction: Bool {
        switch self {
        case .credentials: return true
        case .http(let status, _): return [400, 401, 403, 404, 422].contains(status)
        default: return false
        }
    }
    var message: String {
        switch self {
        case .storage: return "Kunne ikke lagre lokalt. Føringen er pauset."
        case .credentials: return "Kan ikke lese eller lagre Toggl-tokenet i nøkkelringen. Koble til igjen."
        case .http(let status, _):
            switch status {
            case 401, 403: return "Toggl avviste tilgangen. Kontroller token og tilgang til arbeidsområdet."
            case 402, 429: return "Toggl-kvoten er brukt opp. Tiden lagres lokalt til synkronisering er mulig."
            case 404: return "Registreringen eller prosjektet finnes ikke lenger i Toggl."
            case 400, 422: return "Toggl avviste registreringen. Kontroller prosjekt og arbeidsområdets krav."
            default: return "Toggl svarer ikke som forventet. Prøver igjen senere."
            }
        case .quota: return "API-budsjettet er brukt opp. Tiden lagres lokalt."
        case .network: return "Ingen forbindelse til Toggl. Tiden lagres lokalt."
        case .invalidResponse: return "Svaret fra Toggl kunne ikke bekreftes."
        }
    }
}

struct TogglResponseMetadata {
    var quotaRemaining: Int?
    var quotaResetsIn: Double?
    var retryAfter: Double?

    init(quotaRemaining: Int? = nil, quotaResetsIn: Double? = nil, retryAfter: Double? = nil) {
        self.quotaRemaining = quotaRemaining
        self.quotaResetsIn = quotaResetsIn
        self.retryAfter = retryAfter
    }

    init(response: HTTPURLResponse, now: Double) {
        self.init()
        if let raw = response.value(forHTTPHeaderField: "X-Toggl-Quota-Remaining"),
           let value = Int(raw.trimmingCharacters(in: .whitespaces)), value >= 0 { quotaRemaining = value }
        quotaResetsIn = Self.seconds(response.value(forHTTPHeaderField: "X-Toggl-Quota-Resets-In"))
        if let raw = response.value(forHTTPHeaderField: "Retry-After") {
            retryAfter = Self.seconds(raw)
            if retryAfter == nil {
                let formatter = DateFormatter()
                formatter.locale = Locale(identifier: "en_US_POSIX")
                formatter.timeZone = TimeZone(secondsFromGMT: 0)
                formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
                if let date = formatter.date(from: raw) { retryAfter = max(0, date.timeIntervalSince1970 - now) }
            }
        }
    }

    static func seconds(_ raw: String?) -> Double? {
        guard let raw = raw, let value = Double(raw.trimmingCharacters(in: .whitespaces)),
              value.isFinite, value >= 0 else { return nil }
        return value
    }
}

// Keep headers even when HTTP or JSON decoding fails.
struct TogglResponse<Value> {
    var result: Result<Value, TogglError>
    var metadata = TogglResponseMetadata()
}

protocol TogglTransport {
    func send(_ request: URLRequest, completion: @escaping (TogglResponse<Data>) -> Void)
}

final class TogglURLTransport: NSObject, TogglTransport, URLSessionTaskDelegate {
    lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    // Never forward credentials to a redirect destination.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func send(_ request: URLRequest, completion: @escaping (TogglResponse<Data>) -> Void) {
        session.dataTask(with: request) { data, response, error in
            let result: Result<Data, TogglError>
            let metadata = (response as? HTTPURLResponse).map {
                TogglResponseMetadata(response: $0, now: Date().timeIntervalSince1970)
            } ?? TogglResponseMetadata()
            if let error = error as? URLError {
                let preflight: [URLError.Code] = [.notConnectedToInternet, .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost]
                result = .failure(.network(!preflight.contains(error.code)))
            } else if error != nil {
                result = .failure(.network(true))
            } else if let response = response as? HTTPURLResponse {
                if (200..<300).contains(response.statusCode), let data = data {
                    result = .success(data)
                } else {
                    result = .failure(.http(response.statusCode, metadata.retryAfter))
                }
            } else { result = .failure(.invalidResponse) }
            DispatchQueue.main.async { completion(TogglResponse(result: result, metadata: metadata)) }
        }.resume()
    }
}

final class TogglClient {
    let transport: TogglTransport
    let credentials: TogglCredentials
    init(transport: TogglTransport = TogglURLTransport(), credentials: TogglCredentials = TogglKeychain()) {
        self.transport = transport
        self.credentials = credentials
    }
    func request<T: Decodable>(_ method: String, path: String, account: Int64?, token: String? = nil,
                               body: [String: Any]? = nil, completion: @escaping (TogglResponse<T>) -> Void) {
        do {
            let secret: String
            if let token = token { secret = token }
            else if let account = account { secret = try credentials.token(accountID: account) }
            else { throw TogglError.credentials }
            guard let url = URL(string: "https://api.track.toggl.com/api/v9" + path) else { throw TogglError.invalidResponse }
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.timeoutInterval = 20
            request.setValue("Basic " + Data("\(secret):api_token".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let body = body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
            transport.send(request) { response in
                let result: Result<T, TogglError> = response.result.flatMap { data in
                    do { return .success(try JSONDecoder().decode(T.self, from: data)) }
                    catch { return .failure(.invalidResponse) }
                }
                completion(TogglResponse(result: result, metadata: response.metadata))
            }
        } catch let error as TogglError { completion(TogglResponse(result: .failure(error))) }
        catch { completion(TogglResponse(result: .failure(.invalidResponse))) }
    }
}
