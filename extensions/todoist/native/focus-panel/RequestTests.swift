import Foundation

struct RequestTests {
    static func run() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("focus-inbox-\(UUID().uuidString)")
        let requests = directory.appendingPathComponent("requests")
        try FileManager.default.createDirectory(at: requests, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let inbox = FocusRequestInbox(directory: directory)
        let oldTask = FocusTask(id: "completed", title: "Previously completed task", url: "https://todoist.com/app/task/completed")
        let newTask = FocusTask(id: "selected", title: "New focus task", url: "https://todoist.com/app/task/selected")
        let legacy = FocusRequest(id: "old-start", action: "start", task: oldTask, duration: 1500)
        let start = FocusRequest(id: "new-start", action: "start", task: newTask, duration: 1500)
        let legacyURL = directory.appendingPathComponent("request.json")
        let startURL = requests.appendingPathComponent("001-start.json")
        func write(_ request: FocusRequest, to url: URL) throws {
            try JSONEncoder().encode(request).write(to: url, options: .atomic)
        }

        // Exact upgrade regression: v1 leaves its last start in request.json.
        // Processing the new queue must not forget that receipt or resurrect it.
        var old = FocusSnapshot(session: FocusSession(task: oldTask, duration: 1500))
        old.session?.end()
        old.requestId = legacy.id
        old.version = 1
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as! [String: Any]
        object.removeValue(forKey: "acknowledgedRequests")
        object.removeValue(forKey: "tracking")
        let migrated = try JSONDecoder().decode(FocusSnapshot.self, from: JSONSerialization.data(withJSONObject: object))
        assert(migrated.acknowledgedRequests == [legacy.id], "Migration must remember the last v1 receipt")
        var saved = migrated
        let coordinator = FocusCoordinator(snapshot: migrated, write: { saved = $0 })
        var handled: [String] = []
        func handle(_ request: FocusRequest) -> Bool {
            if coordinator.snapshot.acknowledgedRequests.contains(request.id) { return true }
            handled.append(request.id)
            if let task = request.task {
                guard coordinator.start(task: task, duration: request.duration ?? 1500) else { return false }
            }
            coordinator.snapshot.acknowledge(request.id)
            return coordinator.persist()
        }
        try write(legacy, to: legacyURL)
        try write(start, to: startURL)
        inbox.consume(handle)
        assert(saved.session?.task.id == newTask.id && saved.session?.phase == .running)
        assert(saved.tracking.periods.count == 1 && saved.tracking.periods[0].task.id == newTask.id,
               "The obsolete task must not open a work period or trigger a Toggl start")
        assert(handled == [start.id])
        assert(!FileManager.default.fileExists(atPath: legacyURL.path))
        assert(!FileManager.default.fileExists(atPath: startURL.path))
        let sessionID = saved.session?.id
        // A late copy of the old file is still ignored after state reload.
        coordinator.snapshot = try JSONDecoder().decode(FocusSnapshot.self, from: JSONEncoder().encode(saved))
        try write(legacy, to: legacyURL)
        inbox.consume(handle)
        assert(coordinator.snapshot.session?.id == sessionID && handled == [start.id])

        // Even an unacknowledged legacy message is obsolete if a modern command
        // is waiting. A failed save must leave both messages available to retry.
        let unseen = FocusRequest(id: "unseen-legacy", action: "start", task: oldTask)
        let next = FocusRequest(id: "next-start", action: "start", task: newTask)
        let later = FocusRequest(id: "later-stop", action: "stop", taskId: newTask.id)
        let laterURL = requests.appendingPathComponent("002-stop.json")
        try write(unseen, to: legacyURL)
        try write(next, to: startURL)
        try write(later, to: laterURL)
        var attempted: [String] = []
        inbox.consume { request in attempted.append(request.id); return false }
        assert(attempted == [next.id], "Do not overtake a command whose state could not be saved")
        assert(FileManager.default.fileExists(atPath: legacyURL.path))
        assert(FileManager.default.fileExists(atPath: startURL.path))
        attempted = []
        inbox.consume { request in attempted.append(request.id); return true }
        assert(attempted == [next.id, later.id], "Modern commands must keep their queue order")
        assert(!FileManager.default.fileExists(atPath: legacyURL.path))
        let remaining = try FileManager.default.contentsOfDirectory(atPath: requests.path)
        assert(remaining.isEmpty)

        // Old clients still work when there are no newer commands. If such a
        // client writes another command during handling, do not remove it unseen.
        try write(unseen, to: legacyURL)
        attempted = []
        inbox.consume { request in
            attempted.append(request.id)
            try! write(legacy, to: legacyURL)
            return true
        }
        assert(attempted == [unseen.id])
        inbox.consume { request in attempted.append(request.id); return true }
        assert(attempted == [unseen.id, legacy.id])
        assert(!FileManager.default.fileExists(atPath: legacyURL.path))
        print("Focus inbox checks passed: legacy migration, stale start, durable acknowledgement, failed save, ordered commands, old clients.")
    }
}
