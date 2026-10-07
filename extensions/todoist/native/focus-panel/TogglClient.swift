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

protocol TogglTransport {
    func send(_ request: URLRequest, completion: @escaping (Result<Data, TogglError>) -> Void)
}

final class TogglURLTransport: NSObject, TogglTransport, URLSessionTaskDelegate {
    lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    // Never forward credentials to a redirect destination.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func send(_ request: URLRequest, completion: @escaping (Result<Data, TogglError>) -> Void) {
        session.dataTask(with: request) { data, response, error in
            let result: Result<Data, TogglError>
            if let error = error as? URLError {
                let preflight: [URLError.Code] = [.notConnectedToInternet, .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost]
                result = .failure(.network(!preflight.contains(error.code)))
            } else if error != nil {
                result = .failure(.network(true))
            } else if let response = response as? HTTPURLResponse {
                if (200..<300).contains(response.statusCode), let data = data {
                    result = .success(data)
                } else {
                    let retry = response.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
                    result = .failure(.http(response.statusCode, retry))
                }
            } else { result = .failure(.invalidResponse) }
            DispatchQueue.main.async { completion(result) }
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
                               body: [String: Any]? = nil, completion: @escaping (Result<T, TogglError>) -> Void) {
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
            transport.send(request) { result in
                completion(result.flatMap { data in
                    do { return .success(try JSONDecoder().decode(T.self, from: data)) }
                    catch { return .failure(.invalidResponse) }
                })
            }
        } catch let error as TogglError { completion(.failure(error)) }
        catch { completion(.failure(.invalidResponse)) }
    }
}
