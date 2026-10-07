import Foundation
import Darwin

struct TogglWorkspace: Codable {
    var id: Int64
    var name: String
    var organization_id: Int64?
}

struct TogglProject: Codable {
    var id: Int64
    var name: String
    var workspace_id: Int64?
    var wid: Int64?
    var active: Bool?
    var can_track_time: Bool?
    var workspaceID: Int64? { workspace_id ?? wid }
}

struct TogglProfile: Decodable {
    var id: Int64
    var workspaces: [TogglWorkspace]?
    var projects: [TogglProject]?
}

struct TogglEntry: Codable, Equatable {
    var id: Int64
    var workspace_id: Int64
    var project_id: Int64?
    var description: String?
    var start: String
    var stop: String?
    var duration: Int
    var at: String?

    var isRunning: Bool { duration < 0 && stop == nil }
    func matches(_ other: TogglEntry) -> Bool {
        id == other.id && workspace_id == other.workspace_id && project_id == other.project_id &&
        (description ?? "") == (other.description ?? "") && TogglDate.parse(start) == TogglDate.parse(other.start) &&
        stop.flatMap(TogglDate.parse) == other.stop.flatMap(TogglDate.parse) &&
        (isRunning && other.isRunning || duration == other.duration) &&
        (at == nil || other.at == nil || at == other.at)
    }
}

enum TogglDate {
    static func string(_ seconds: Double) -> String {
        ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: floor(seconds)))
    }
    static func parse(_ string: String) -> Double? {
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: string) { return date.timeIntervalSince1970 }
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter.date(from: string)?.timeIntervalSince1970
    }
}

struct TogglSettings: Codable {
    var accountID: Int64?
    var workspaceID: Int64?
    var organizationID: Int64?
    var enabled = false
    var includeTaskLink = false
    var defaultProjectID: Int64?
    // A stored 0 is an explicit "Uten prosjekt", distinct from no saved choice.
    var projectChoices: [String: Int64] = [:]
    var workspaces: [TogglWorkspace] = []
    var projects: [TogglProject] = []
    var cachedAt: Double = 0

    func project(for task: FocusTask) -> Int64? {
        guard let key = mappingKey(task) else { return defaultProjectID }
        guard let choice = projectChoices[key] else { return defaultProjectID }
        return choice == 0 ? nil : choice
    }
    func mappingKey(_ task: FocusTask) -> String? {
        guard let project = task.projectId, let workspace = workspaceID, let account = accountID else { return nil }
        return "\(account):\(workspace):\(project)"
    }
    var availableProjects: [TogglProject] {
        projects.filter { $0.workspaceID == workspaceID && $0.active != false && $0.can_track_time != false }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
}

enum PeriodSync: String, Codable {
    case local, pending, creating, running, updating, synced, uncertain, review, accepted
}

struct WorkPeriod: Codable {
    var id = UUID().uuidString
    var sessionID: String
    var task: FocusTask
    var start: Double
    var stop: Double?
    var activeDuration: Double = 0
    var checkpoint: Double
    var accountID: Int64?
    var workspaceID: Int64?
    var organizationID: Int64?
    var projectID: Int64?
    var description: String
    var sync: PeriodSync
    var remote: TogglEntry?
    var externalVersion: TogglEntry?
    var candidates: [TogglEntry] = []
    var issue: String?
    var recoveryDetectedAt: Double?
    var foreignTimer = false
    var creationUncertain = false

    var seconds: Int { max(0, Int(activeDuration.rounded())) }
    var wireStart: Double { floor(start) }
    var wireStop: Double { wireStart + Double(seconds) }
    var hasAutomaticWork: Bool {
        [.pending, .creating, .updating, .uncertain].contains(sync) || (sync == .running && stop != nil)
    }
    func agreesWithLocal(_ entry: TogglEntry) -> Bool {
        guard entry.workspace_id == workspaceID, entry.project_id == projectID,
              (entry.description ?? "") == description, TogglDate.parse(entry.start) == wireStart else { return false }
        if stop == nil { return entry.isRunning }
        return !entry.isRunning && entry.duration == seconds && entry.stop.flatMap(TogglDate.parse) == wireStop
    }
    var payload: [String: Any] {
        var result: [String: Any] = ["created_with": "Todoist Focus Panel", "description": description,
                                    "workspace_id": workspaceID!, "start": TogglDate.string(wireStart),
                                    "duration": stop == nil ? -1 : seconds,
                                    "project_id": projectID.map { $0 as Any } ?? NSNull()]
        if remote == nil { result["billable"] = false }
        result["stop"] = stop == nil ? NSNull() : TogglDate.string(wireStop) as Any
        return result
    }
}

struct RequestBudget: Codable {
    var attempts: [Double] = []
    var blockedUntil: Double = 0
    var failures = 0

    mutating func earliest(now: Double, urgent: Bool) -> Double {
        attempts.removeAll { $0 <= now - 3600 }
        let limit = urgent ? 30 : 28 // Leave room for stopping an active timer.
        return max(blockedUntil, attempts.count >= limit ? (attempts.first ?? now) + 3600 : now)
    }
}

struct TogglTakeover: Codable {
    var accountID: Int64
    var organizationID: Int64?
    var entry: TogglEntry
    var stopAt: Double
    var periodID: String
    var resumeOnSuccess = true
    var issue: String?
}

struct TrackingState: Codable {
    var settings = TogglSettings()
    var periods: [WorkPeriod] = []
    var budgets: [String: RequestBudget] = [:]
    var takeover: TogglTakeover?
    var message: String?
}

// Injectable storage is also the durability boundary exercised by the tests.
final class FocusStore {
    let file: URL
    init(directory: URL) { file = directory.appendingPathComponent("state.json") }
    func load() throws -> FocusSnapshot? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return try JSONDecoder().decode(FocusSnapshot.self, from: Data(contentsOf: file))
    }
    func save(_ snapshot: FocusSnapshot) throws {
        let data = try JSONEncoder().encode(snapshot)
        let temporary = file.deletingLastPathComponent().appendingPathComponent(".state-\(UUID().uuidString).tmp")
        let descriptor = open(temporary.path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
        guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close(); try? FileManager.default.removeItem(at: temporary) }
        try handle.write(contentsOf: data)
        try handle.synchronize()
        guard rename(temporary.path, file.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
        let parent = open(file.deletingLastPathComponent().path, O_RDONLY)
        if parent >= 0 { _ = fsync(parent); close(parent) }
    }
}
