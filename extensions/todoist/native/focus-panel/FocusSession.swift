import Foundation

struct FocusTask: Codable {
    var id: String
    var title: String
    var url: String
    var completionURL: String?
    var projectId: String?
}

struct FocusCompletionResult: Codable {
    var sessionId: String
    var success: Bool
    var error: String?
}

struct FocusRequest: Codable {
    var id: String
    var action: String
    var task: FocusTask?
    var duration: Double?
    var taskId: String?
    var sessionId: String?
}

enum FocusPhase: String, Codable {
    case running, paused, finished, ended
}

// The session owns active time. Pauses, sleep and time spent with the helper closed
// are never counted. This is also the boundary for a future time-tracking adapter.
struct FocusSession: Codable {
    var id = UUID().uuidString
    var task: FocusTask
    var duration: Double
    var elapsed: Double = 0
    var phase: FocusPhase = .running
    var togglEnabled: Bool?

    init(task: FocusTask, duration: Double) {
        self.task = task
        self.duration = duration.isFinite ? min(86400, max(0, duration)) : 1500
    }

    var remaining: Double { max(0, duration - elapsed) }
    var progress: Double { duration > 0 ? min(1, elapsed / duration) : 0 }

    var completionDeeplink: URL? {
        guard let string = task.completionURL,
              var components = URLComponents(string: string),
              components.scheme?.hasPrefix("raycast") == true,
              let data = try? JSONEncoder().encode(["sessionId": id, "taskId": task.id]),
              let json = String(data: data, encoding: .utf8) else { return nil }
        // Raycast's URL parameter is `context`; it becomes `launchContext` in LaunchProps.
        components.queryItems = (components.queryItems ?? []).filter {
            $0.name != "context" && $0.name != "launchContext"
        } + [URLQueryItem(name: "context", value: json)]
        return components.url
    }

    mutating func advance(by seconds: Double) {
        guard phase == .running, seconds.isFinite, seconds > 0 else { return }
        elapsed += seconds
        if duration > 0 && elapsed >= duration {
            elapsed = duration
            phase = .finished
        }
    }

    mutating func pause() {
        if phase == .running { phase = .paused }
    }

    mutating func resume() {
        if phase == .paused { phase = .running }
    }

    mutating func restore() {
        // A persisted running session must not accrue time while its process is gone.
        pause()
    }

    mutating func setDuration(_ seconds: Double) {
        guard seconds.isFinite, seconds >= 0, seconds <= 86400 else { return }
        duration = seconds
        if duration > 0 && elapsed >= duration {
            phase = .finished
        } else if phase == .finished {
            phase = .paused
        }
    }

    mutating func extend() {
        guard duration > 0 else { return }
        duration = min(86400, max(duration, elapsed) + 300)
        if phase == .finished && remaining > 0 { phase = .running }
    }

    mutating func end() { phase = .ended }
}

struct FocusAppearance: Codable {
    var fontSize: Double = 26
    var width: Double = 480
    var height: Double = 350
    var x: Double?
    var y: Double?
}

struct FocusSnapshot: Codable {
    var version = 2
    var session: FocusSession?
    var appearance = FocusAppearance()
    var requestId = ""
    var updatedAt = Date().timeIntervalSince1970
    var tracking = TrackingState()
    var acknowledgedRequests: [String] = []

    init(session: FocusSession? = nil, appearance: FocusAppearance = FocusAppearance()) {
        self.session = session
        self.appearance = appearance
    }

    enum CodingKeys: String, CodingKey { case version, session, appearance, requestId, updatedAt, tracking, acknowledgedRequests }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let version = try values.decode(Int.self, forKey: .version)
        guard version == 1 || version == 2 else {
            throw DecodingError.dataCorruptedError(forKey: .version, in: values, debugDescription: "Ukjent fokusversjon")
        }
        session = try values.decodeIfPresent(FocusSession.self, forKey: .session)
        appearance = try values.decodeIfPresent(FocusAppearance.self, forKey: .appearance) ?? FocusAppearance()
        requestId = try values.decodeIfPresent(String.self, forKey: .requestId) ?? ""
        updatedAt = try values.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
        tracking = try values.decodeIfPresent(TrackingState.self, forKey: .tracking) ?? TrackingState()
        acknowledgedRequests = try values.decodeIfPresent([String].self, forKey: .acknowledgedRequests) ?? []
        // v1 elapsed time has no reliable wall-clock history and is never uploaded.
        self.version = 2
    }
}
