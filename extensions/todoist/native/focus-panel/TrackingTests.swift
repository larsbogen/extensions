import Foundation

private final class TestClock {
    var wall: Double = 1_700_000_000
    var uptime: Double = 100
    func advance(_ seconds: Double) { wall += seconds; uptime += seconds }
}
private final class MemoryCredentials: TogglCredentials {
    var tokens: [Int64: String] = [1: "test-secret-never-persist"]
    func token(accountID: Int64) throws -> String {
        guard let value = tokens[accountID] else { throw TogglError.credentials }
        return value
    }
    func save(token: String, accountID: Int64) throws { tokens[accountID] = token }
}
private final class FakeToggl: TogglTransport {
    var requests: [URLRequest] = []
    var entries: [Int64: TogglEntry] = [:]
    var nextID: Int64 = 100
    var failure: ((URLRequest) -> TogglError?)?
    var afterCreateFailure: TogglError?
    var afterUpdateFailure: TogglError?
    var holdCreate = false
    var holdUpdate = false
    var held: (() -> Void)?
    var beforeRequest: ((URLRequest) -> Void)?
    var creates: Int { requests.filter { $0.httpMethod == "POST" }.count }
    func send(_ request: URLRequest, completion: @escaping (Result<Data, TogglError>) -> Void) {
        beforeRequest?(request)
        requests.append(request)
        if let error = failure?(request) { completion(.failure(error)); return }
        let path = request.url!.path
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        func respond<T: Encodable>(_ value: T) { completion(.success(try! JSONEncoder().encode(value))) }
        if request.httpMethod == "GET" && path.hasSuffix("/current") {
            respond(entries.values.first { $0.isRunning })
        } else if request.httpMethod == "GET" && path.hasSuffix("/time_entries") {
            respond(Array(entries.values))
        } else if request.httpMethod == "GET" && path.hasSuffix("/me") {
            completion(.success(Data("{\"id\":1,\"workspaces\":[{\"id\":10,\"name\":\"Work\",\"organization_id\":20}],\"projects\":[]}".utf8)))
        } else if request.httpMethod == "POST" {
            let entry = TogglEntry(id: nextID, workspace_id: (body["workspace_id"] as! NSNumber).int64Value,
                project_id: (body["project_id"] as? NSNumber)?.int64Value,
                description: body["description"] as? String, start: body["start"] as! String,
                stop: body["stop"] as? String, duration: body["duration"] as! Int)
            nextID += 1
            entries[entry.id] = entry
            let response = {
                if let error = self.afterCreateFailure { self.afterCreateFailure = nil; completion(.failure(error)) }
                else { respond(entry) }
            }
            if holdCreate { holdCreate = false; held = response } else { response() }
        } else if let id = Int64(path.split(separator: "/").last!), var entry = entries[id] {
            if request.httpMethod == "PUT" {
                if let description = body["description"] as? String { entry.description = description }
                if let start = body["start"] as? String { entry.start = start }
                if let stop = body["stop"] as? String { entry.stop = stop }
                if let duration = body["duration"] as? Int { entry.duration = duration }
                if body.keys.contains("project_id") { entry.project_id = (body["project_id"] as? NSNumber)?.int64Value }
                entries[id] = entry
                if let error = afterUpdateFailure { afterUpdateFailure = nil; completion(.failure(error)); return }
                if holdUpdate { holdUpdate = false; held = { respond(entry) }; return }
            }
            respond(entry)
        } else { completion(.failure(.http(404, nil))) }
    }
}

private final class TrackingHarness {
    let clock = TestClock()
    let server = FakeToggl()
    let credentials = MemoryCredentials()
    var engine: FocusCoordinator!
    var saved: Data?
    var failStorage = false
    var writes = 0
    let task = FocusTask(id: "task-a", title: "Arbeid æøå", url: "https://todoist.com/app/task/task-a", projectId: "todoist-project")
    init(enabled: Bool = true) {
        var snapshot = FocusSnapshot()
        snapshot.tracking.settings.accountID = 1
        snapshot.tracking.settings.workspaceID = 10
        snapshot.tracking.settings.organizationID = 20
        snapshot.tracking.settings.enabled = enabled
        makeEngine(snapshot)
    }
    func makeEngine(_ snapshot: FocusSnapshot) {
        engine = FocusCoordinator(snapshot: snapshot, client: TogglClient(transport: server, credentials: credentials),
            now: { self.clock.wall }, uptime: { self.clock.uptime }, write: { value in
                if self.failStorage { throw CocoaError(.fileWriteOutOfSpace) }
                self.saved = try JSONEncoder().encode(value)
                self.writes += 1
            })
    }
    func work(_ seconds: Double) { clock.advance(seconds); engine.advance() }
    func restart(after seconds: Double = 0) {
        clock.advance(seconds)
        let snapshot = try! JSONDecoder().decode(FocusSnapshot.self, from: saved!)
        makeEngine(snapshot)
        engine.restore()
        _ = engine.persist()
        engine.requestSync()
    }
    func start(duration: Double = 1500) { assert(engine.start(task: task, duration: duration)) }
    var periods: [WorkPeriod] { engine.snapshot.tracking.periods }
}

enum TrackingTests {
    static func run() throws {
        do {
            let h = TrackingHarness()
            h.start(); h.work(720); h.engine.pause()
            h.clock.advance(300); h.restart()
            h.engine.togglePause(); h.work(480); h.engine.pause()
            assert(h.periods.count == 2)
            assert(h.periods.map(\.seconds) == [720, 480])
            assert(h.server.entries.values.reduce(0) { $0 + $1.duration } == 1200)
            assert(h.server.creates == 2)
            assert(h.engine.snapshot.session?.elapsed == 1200)
            let entries = h.server.entries.values.sorted { $0.start < $1.start }
            assert(TogglDate.parse(entries[1].start)! - TogglDate.parse(entries[0].stop!)! == 300)
            assert(h.engine.status == "På pause")
            assert(!String(data: h.saved!, encoding: .utf8)!.contains("test-secret"))
            h.engine.requestSync(); h.engine.requestSync()
            assert(h.server.creates == 2)
        }
        do {
            let h = TrackingHarness()
            h.server.failure = { _ in .network(false) }
            h.start(); h.work(720); h.engine.pause()
            h.restart(after: 300)
            h.engine.togglePause(); h.work(480); h.engine.pause()
            assert(h.periods.map(\.seconds) == [720, 480])
            h.server.failure = nil
            h.clock.advance(3600)
            h.engine.requestSync()
            assert(h.server.entries.count == 2)
            assert(h.server.entries.values.reduce(0) { $0 + $1.duration } == 1200)
            assert(h.periods.allSatisfy { $0.sync == .synced })
        }
        do {
            let h = TrackingHarness()
            h.start(); h.work(720); h.engine.persist(); h.work(4)
            h.restart(after: 600)
            assert(h.engine.snapshot.session?.phase == .paused)
            assert(h.periods[0].seconds == 720)
            assert(h.server.entries[100]?.duration == 720)
            assert(h.periods[0].recoveryDetectedAt != nil)
            h.engine.correctRecovery(h.periods[0].id, stop: h.periods[0].start + 724)
            assert(h.server.entries[100]?.duration == 724)
            assert(h.engine.snapshot.session?.elapsed == 724)
        }
        do {
            let h = TrackingHarness()
            h.server.afterCreateFailure = .network(true)
            h.start(); h.work(12); h.engine.pause()
            h.clock.advance(10); h.engine.requestSync()
            assert(h.server.creates == 1)
            assert(h.periods[0].sync == .review)
            assert(h.periods[0].creationUncertain)
            assert(h.periods[0].candidates.count == 1)
            h.engine.useLocal(h.periods[0].id, candidate: h.periods[0].candidates[0])
            assert(h.server.creates == 1 && h.server.entries[100]?.duration == 12)
        }
        do {
            let h = TrackingHarness()
            h.server.failure = { $0.httpMethod == "POST" ? .network(true) : nil }
            h.start(); h.work(20); h.engine.pause()
            h.clock.advance(10); h.engine.requestSync()
            assert(h.periods[0].sync == .review && h.periods[0].candidates.isEmpty)
            h.restart(after: 3600); h.engine.requestSync()
            assert(h.server.creates == 1, "An empty lookup must never cause automatic re-creation")
        }
        do {
            let h = TrackingHarness()
            h.start(); h.work(60)
            h.server.failure = { $0.httpMethod == "PUT" ? .http(402, nil) : nil }
            h.engine.pause()
            assert(h.engine.pendingStop && h.server.entries[100]?.isRunning == true)
            let savedStop = h.periods[0].wireStop
            h.restart(after: 1800)
            assert(h.server.requests.filter { $0.httpMethod == "PUT" }.count == 1)
            h.server.failure = nil
            h.clock.advance(1801); h.engine.retryIfDue()
            assert(h.server.entries[100]?.duration == 60)
            assert(TogglDate.parse(h.server.entries[100]!.stop!) == savedStop)
            assert(!h.engine.pendingStop)
        }
        do {
            let h = TrackingHarness()
            h.start(); h.work(30)
            h.server.entries[100]?.description = "Redigert i Toggl"
            h.engine.requestSync()
            assert(h.engine.snapshot.session?.phase == .paused)
            assert(h.periods[0].sync == .review)
            assert(h.periods[0].externalVersion?.description == "Redigert i Toggl")
            h.engine.keepExternal(h.periods[0].id)
            assert(h.server.entries[100]?.description == "Redigert i Toggl")
            assert(h.engine.snapshot.session?.phase == .paused)
        }
        do {
            let h = TrackingHarness()
            h.start(); h.work(30)
            h.server.entries[100]?.description = "Endret"
            h.engine.requestSync()
            h.engine.useLocal(h.periods[0].id)
            assert(h.server.entries[100]?.description == h.task.title)
            assert(h.server.entries[100]?.duration == 30)
            assert(h.engine.snapshot.session?.phase == .paused)
        }
        do {
            let h = TrackingHarness()
            h.server.holdCreate = true
            h.start(); h.work(30); h.engine.pause()
            h.engine.start(task: FocusTask(id: "b", title: "Neste", url: h.task.url), duration: 1500)
            h.server.held?(); h.server.held = nil
            assert(h.server.entries[100]?.duration == 30)
            assert(h.server.entries[101]?.isRunning == true)
            assert(h.engine.snapshot.session?.task.id == "b")
        }
        do {
            let h = TrackingHarness()
            let foreign = TogglEntry(id: 9, workspace_id: 10, description: "En annen oppgave", start: TogglDate.string(h.clock.wall - 60), duration: -1)
            h.server.entries[9] = foreign
            h.start()
            assert(h.server.entries[9]?.isRunning == true && h.server.creates == 0)
            assert(h.periods[0].foreignTimer)
            h.engine.takeOver(h.periods[0].id)
            assert(h.server.entries[9]?.duration == 60)
            assert(h.server.entries[100]?.isRunning == true)
        }
        do {
            let h = TrackingHarness()
            h.server.entries[9] = TogglEntry(id: 9, workspace_id: 10, start: TogglDate.string(h.clock.wall), duration: -1)
            h.start(); h.engine.continueWithoutToggl(h.periods[0].id); h.work(60)
            assert(h.server.entries[9]?.isRunning == true && h.server.creates == 0)
            assert(h.engine.snapshot.session?.phase == .running && !h.engine.trackingEnabled)
        }
        do {
            let h = TrackingHarness()
            h.failStorage = true
            assert(!h.engine.start(task: h.task, duration: 1500))
            assert(h.server.requests.isEmpty && h.engine.snapshot.session?.phase == .paused)
            h.failStorage = false
            assert(h.engine.persist())
        }
        do {
            let h = TrackingHarness()
            h.start(); h.work(1499.75); h.work(3)
            assert(h.periods[0].seconds == 1500 && h.engine.snapshot.session?.phase == .finished)
            h.engine.requestSync()
            assert(h.server.entries[100]?.duration == 1500)
            h.engine.editSession { $0.extend() }
            h.work(60); h.engine.pause()
            assert(h.periods.map(\.seconds) == [1500, 60])
        }
        do {
            let h = TrackingHarness(enabled: false)
            h.start(); h.work(60); h.engine.setTracking(true); h.work(120)
            h.engine.chooseProject(200); h.work(180); h.engine.setTracking(false)
            assert(h.periods.map(\.seconds) == [60, 120, 180, 0])
            assert(h.server.entries.count == 2)
            assert(h.server.entries[101]?.project_id == 200)
            assert(h.engine.snapshot.tracking.settings.project(for: h.task) == 200)
            assert(h.engine.snapshot.session?.elapsed == 360)
        }
        do {
            let h = TrackingHarness()
            h.start(); h.work(60); h.engine.pause()
            let id = h.engine.snapshot.session!.id
            h.engine.start(task: h.task, duration: 900)
            assert(h.engine.snapshot.session?.id == id && h.engine.snapshot.session?.phase == .paused)
            assert(h.server.creates == 1)
        }
        do {
            let legacy = Data("{\"version\":1,\"session\":{\"id\":\"old\",\"task\":{\"id\":\"a\",\"title\":\"Old\",\"url\":\"https://todoist.com\"},\"duration\":1500,\"elapsed\":123,\"phase\":\"running\"},\"requestId\":\"old-request\",\"updatedAt\":1}".utf8)
            let snapshot = try JSONDecoder().decode(FocusSnapshot.self, from: legacy)
            assert(snapshot.version == 2 && snapshot.tracking.periods.isEmpty && snapshot.session?.elapsed == 123)
            let h = TrackingHarness(); h.makeEngine(snapshot); h.engine.restore()
            assert(h.engine.snapshot.session?.phase == .paused && h.server.requests.isEmpty)
        }
        do {
            let h = TrackingHarness()
            h.server.beforeRequest = { request in
                if request.httpMethod == "POST" {
                    let saved = try! JSONDecoder().decode(FocusSnapshot.self, from: h.saved!)
                    assert(saved.tracking.periods.last?.sync == .creating)
                    assert(saved.tracking.periods.last?.creationUncertain == true)
                }
                if request.httpMethod == "PUT" {
                    let saved = try! JSONDecoder().decode(FocusSnapshot.self, from: h.saved!)
                    assert(saved.tracking.periods.last?.stop != nil)
                }
            }
            h.start(); h.work(60); h.engine.pause()
        }
        do {
            let h = TrackingHarness()
            h.server.failure = { _ in .http(403, nil) }
            h.start()
            assert(h.engine.snapshot.session?.phase == .paused && h.periods[0].sync == .review)
            assert(h.engine.status.contains("avviste"))
            assert(!h.engine.needsBackground)
        }
        do {
            let h = TrackingHarness()
            h.server.afterUpdateFailure = .network(true)
            h.start(); h.work(60); h.engine.pause()
            assert(h.engine.pendingStop)
            h.restart(after: 10)
            assert(h.periods[0].sync == .synced && h.server.entries[100]?.duration == 60)
            assert(h.server.requests.filter { $0.httpMethod == "PUT" }.count == 1)
        }
        do {
            let h = TrackingHarness()
            h.server.holdCreate = true
            h.start(); h.work(10); h.engine.persist()
            h.restart(after: 100)
            assert(h.periods[0].sync == .review && h.periods[0].creationUncertain)
            assert(h.periods[0].candidates.count == 1 && h.server.creates == 1)
            h.engine.useLocal(h.periods[0].id, candidate: h.periods[0].candidates[0])
            assert(h.server.entries[100]?.duration == 10)
        }
        do {
            let h = TrackingHarness()
            h.server.failure = { _ in .http(429, 120) }
            h.start(); h.work(60); h.engine.pause()
            let count = h.server.requests.count
            h.restart(after: 30)
            assert(h.server.requests.count == count)
            h.server.failure = nil; h.clock.advance(91); h.engine.retryIfDue()
            assert(h.server.entries[100]?.duration == 60)
        }
        do {
            let h = TrackingHarness()
            h.start(); h.work(30)
            h.credentials.tokens[2] = "second-test-token"
            h.engine.configure(profile: TogglProfile(id: 2, workspaces: [], projects: []),
                workspace: TogglWorkspace(id: 30, name: "Other", organization_id: 40), project: nil, includeLink: false, enabled: true)
            h.work(30); h.engine.pause()
            assert(h.periods.map(\.accountID) == [1, 2])
            assert(h.periods.map(\.workspaceID) == [10, 30])
            let posts = h.server.requests.filter { $0.httpMethod == "POST" }
            assert(posts.count == 2)
            assert(posts[0].value(forHTTPHeaderField: "Authorization") != posts[1].value(forHTTPHeaderField: "Authorization"))
            assert(!String(data: h.saved!, encoding: .utf8)!.contains("second-test-token"))
        }
        for restart in [false, true] {
            let h = TrackingHarness()
            h.server.entries[9] = TogglEntry(id: 9, workspace_id: 10, start: TogglDate.string(h.clock.wall - 60), duration: -1)
            h.start()
            h.server.holdUpdate = true
            h.engine.takeOver(h.periods[0].id)
            if restart { h.restart(after: 30) }
            else { h.engine.pause(); h.server.held?() }
            assert(h.engine.snapshot.session?.phase == .paused, "A late takeover must not resume after close, lock or restart")
            assert(h.server.creates == 0)
        }
        do {
            var budget = RequestBudget(attempts: Array(repeating: 100, count: 28))
            assert(budget.earliest(now: 101, urgent: false) == 3700)
            assert(budget.earliest(now: 101, urgent: true) == 101)
            budget.attempts += [100, 100]
            assert(budget.earliest(now: 101, urgent: true) == 3700)
            assert(budget.earliest(now: 3700, urgent: false) == 3700)
        }
        do {
            let h = TrackingHarness()
            h.start(); h.work(60)
            h.clock.wall += 3600
            h.engine.advance()
            assert(h.engine.snapshot.session?.phase == .paused && h.periods[0].seconds == 60)
        }
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("toggl-store-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = FocusStore(directory: directory)
            try store.save(FocusSnapshot())
            let loaded = try store.load()
            assert(loaded?.version == 2)
            let permissions = try FileManager.default.attributesOfItem(atPath: store.file.path)[.posixPermissions] as! NSNumber
            assert(permissions.intValue == 0o600)
            try Data("invalid".utf8).write(to: store.file)
            do { _ = try store.load(); assertionFailure("Corrupt data must not become a fresh session") } catch {}
        }
        print("Toggl checks passed: exact periods, offline/restart, recovery, durable intent, ambiguity, quotas, external edits, takeover, late responses, storage failure, migration and credentials.")
    }
}
