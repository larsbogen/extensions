import Foundation

struct FocusQueueContext: Codable, Equatable {
    var accountId: String
    var day: String
    var entryId: String
    var revision: Int
}

struct FocusTask: Codable {
    var id: String
    var title: String
    var url: String
    var completionURL: String?
    var projectId: String?
    var projectName: String?
    var todoistUserId: String?
    var queue: FocusQueueContext?
    var nextURL: String?
}

struct FocusCompletionResult: Codable {
    var sessionId: String
    var success: Bool
    var error: String?
}

struct FocusNextResult: Codable {
    var sessionId: String
    var requestId: String
    var success: Bool
    var empty: Bool?
    var error: String?
}

struct FocusRequest: Codable {
    var id: String
    var action: String
    var task: FocusTask?
    var duration: Double?
    var taskId: String?
    var sessionId: String?
    var transitionRequestId: String?
    var expiresAt: Double?
    var automatic: Bool?
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
    var originRequestId: String?
    var pendingNextRequestId: String?
    var queueFinished: Bool?
    var queueCompleted: Bool?

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

    func nextDeeplink(requestId: String) -> URL? {
        guard task.queue != nil, let string = task.nextURL,
              var components = URLComponents(string: string), components.scheme?.hasPrefix("raycast") == true,
              let data = try? JSONEncoder().encode(["sessionId": id, "requestId": requestId]),
              let json = String(data: data, encoding: .utf8) else { return nil }
        components.queryItems = (components.queryItems ?? []).filter { $0.name != "context" && $0.name != "launchContext" }
            + [URLQueryItem(name: "context", value: json)]
        return components.url
    }

    func acceptsTransition(_ request: FocusRequest) -> Bool {
        request.sessionId == id && request.transitionRequestId != nil && request.transitionRequestId == pendingNextRequestId
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

enum FocusViewMode: String, Codable { case compact, expanded }

struct FocusWindowSize: Codable, Equatable {
    var width: Double
    var height: Double
}

struct FocusAppearance: Codable {
    var fontSize: Double = 26
    // Legacy width/height remain the expanded size, including after migration.
    var width: Double = 480
    var height: Double = 350
    var x: Double?
    var y: Double?
    var mode: FocusViewMode = .compact
    var compactSize = FocusWindowSize(width: 360, height: 240)

    init(fontSize: Double = 26, width: Double = 480, height: Double = 350, x: Double? = nil, y: Double? = nil) {
        self.fontSize = fontSize; self.width = width; self.height = height; self.x = x; self.y = y
    }
    var size: FocusWindowSize {
        get { mode == .compact ? compactSize : FocusWindowSize(width: width, height: height) }
        set {
            if mode == .compact { compactSize = newValue }
            else { width = newValue.width; height = newValue.height }
        }
    }
    mutating func recordResize(from previous: FocusWindowSize, to actual: FocusWindowSize) {
        // A width-only resize must not adopt a temporary warning height.
        size = FocusWindowSize(width: actual.width, height: abs(actual.height - previous.height) > 0.5 ? actual.height : size.height)
    }
    enum CodingKeys: String, CodingKey { case fontSize, width, height, x, y, mode, compactSize }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        fontSize = try values.decodeIfPresent(Double.self, forKey: .fontSize) ?? 26
        width = try values.decodeIfPresent(Double.self, forKey: .width) ?? 480
        height = try values.decodeIfPresent(Double.self, forKey: .height) ?? 350
        x = try values.decodeIfPresent(Double.self, forKey: .x)
        y = try values.decodeIfPresent(Double.self, forKey: .y)
        mode = try values.decodeIfPresent(FocusViewMode.self, forKey: .mode) ?? .compact
        compactSize = try values.decodeIfPresent(FocusWindowSize.self, forKey: .compactSize) ?? FocusWindowSize(width: 360, height: 240)
    }
}

struct FocusSnapshot: Codable {
    var version = 3
    var session: FocusSession?
    var appearance = FocusAppearance()
    var requestId = ""
    var updatedAt = Date().timeIntervalSince1970
    var tracking = TrackingState()
    var acknowledgedRequests: [String] = []
    var undatedLegacySeconds: Double?

    init(session: FocusSession? = nil, appearance: FocusAppearance = FocusAppearance()) {
        self.session = session
        self.appearance = appearance
    }

    mutating func acknowledge(_ id: String) {
        // v1 stored only requestId. Keep that receipt when the first queued
        // command replaces it, so a leftover request.json cannot replay it.
        for receipt in [requestId, id] where !receipt.isEmpty && !acknowledgedRequests.contains(receipt) {
            acknowledgedRequests.append(receipt)
        }
        acknowledgedRequests = Array(acknowledgedRequests.suffix(256))
        requestId = id
    }

    enum CodingKeys: String, CodingKey { case version, session, appearance, requestId, updatedAt, tracking, acknowledgedRequests, undatedLegacySeconds }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let version = try values.decode(Int.self, forKey: .version)
        guard (1...3).contains(version) else {
            throw DecodingError.dataCorruptedError(forKey: .version, in: values, debugDescription: "Ukjent fokusversjon")
        }
        session = try values.decodeIfPresent(FocusSession.self, forKey: .session)
        appearance = try values.decodeIfPresent(FocusAppearance.self, forKey: .appearance) ?? FocusAppearance()
        requestId = try values.decodeIfPresent(String.self, forKey: .requestId) ?? ""
        updatedAt = try values.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
        tracking = try values.decodeIfPresent(TrackingState.self, forKey: .tracking) ?? TrackingState()
        acknowledgedRequests = try values.decodeIfPresent([String].self, forKey: .acknowledgedRequests) ?? []
        acknowledge(requestId)
        undatedLegacySeconds = try values.decodeIfPresent(Double.self, forKey: .undatedLegacySeconds)
        if version < 3, let session = session {
            let dated = tracking.periods.filter { $0.sessionID == session.id }.reduce(0) { $0 + $1.activeDuration }
            let undated = max(0, session.elapsed - dated)
            if undated > 0 { undatedLegacySeconds = max(undatedLegacySeconds ?? 0, undated) }
        }
        // v1 elapsed time has no reliable wall-clock history and is never uploaded.
        self.version = 3
    }
}
