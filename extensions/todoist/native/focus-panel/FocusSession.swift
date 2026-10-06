import Foundation

struct FocusTask: Codable {
    var id: String
    var title: String
    var url: String
    var completionURL: String?
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

    init(task: FocusTask, duration: Double) {
        self.task = task
        self.duration = duration.isFinite ? min(86400, max(0, duration)) : 1500
    }

    var remaining: Double { max(0, duration - elapsed) }
    var progress: Double { duration > 0 ? min(1, elapsed / duration) : 0 }

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
    var version = 1
    var session: FocusSession?
    var appearance = FocusAppearance()
    var requestId = ""
    var updatedAt = Date().timeIntervalSince1970
}
