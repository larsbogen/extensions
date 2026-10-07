import Foundation

@main
struct SessionTests {
    static func main() throws {
        let task = FocusTask(id: "test", title: "En hel oppgavetittel", url: "https://todoist.com/app/task/test")
        var session = FocusSession(task: task, duration: 1500)
        session.advance(by: 60)
        session.pause()
        session.advance(by: 600)
        assert(session.elapsed == 60 && session.remaining == 1440, "Paused time must not be counted")
        session.resume()
        session.advance(by: 1500)
        assert(session.phase == .finished && session.elapsed == 1500 && session.progress == 1)
        session.extend()
        assert(session.phase == .running && session.remaining == 300)
        session.advance(by: 30)
        session.restore()
        session.advance(by: 9999)
        assert(session.phase == .paused && session.elapsed == 1530, "Restart must exclude downtime")
        session.setDuration(0)
        session.resume()
        session.advance(by: 3600)
        assert(session.phase == .running && session.elapsed == 5130, "Open-ended timer must keep running")
        session.advance(by: -.infinity)
        session.advance(by: .nan)
        session.advance(by: -10)
        assert(session.elapsed == 5130)
        session.setDuration(900)
        assert(session.phase == .finished && session.remaining == 0)
        session.setDuration(6000)
        assert(session.phase == .paused)
        session.end()
        session.resume()
        session.advance(by: 100)
        assert(session.phase == .ended && session.elapsed == 5130)
        let saved = FocusSnapshot(session: session, appearance: FocusAppearance(fontSize: 42, width: 700))
        let decoded = try JSONDecoder().decode(FocusSnapshot.self, from: JSONEncoder().encode(saved))
        assert(decoded.session?.task.title == task.title && decoded.appearance.fontSize == 42)
        assert(FocusSession(task: task, duration: -30).duration == 0)
        assert(FocusSession(task: task, duration: 90000).duration == 86400)
        assert(session.completionDeeplink == nil, "Old cards without a completion command cannot complete")
        session.task.completionURL = "https://example.com/complete"
        assert(session.completionDeeplink == nil, "Completion must open Raycast")
        session.task.id = "task/æøå & + ? #"
        session.task.completionURL = "raycast://extensions/doist/todoist/complete-focused-task?launchType=userInitiated&context=old&launchContext=old"
        let link = session.completionDeeplink!
        let components = URLComponents(url: link, resolvingAgainstBaseURL: false)!
        assert(components.path == "/doist/todoist/complete-focused-task")
        let query = components.queryItems!
        assert(query.first(where: { $0.name == "launchType" })?.value == "userInitiated")
        assert(!query.contains(where: { $0.name == "launchContext" }), "Raycast ignores the launchContext URL parameter")
        let contexts = query.filter { $0.name == "context" }
        assert(contexts.count == 1, "Retries replace the context instead of appending duplicate values")
        let context = try JSONDecoder().decode([String: String].self, from: Data(contexts[0].value!.utf8))
        assert(context == ["sessionId": session.id, "taskId": session.task.id], "Raycast must receive the exact session and task IDs")
        let retry = URLComponents(url: session.completionDeeplink!, resolvingAgainstBaseURL: false)!
        let retryJSON = retry.queryItems!.first(where: { $0.name == "context" })!.value!
        let retryContext = try JSONDecoder().decode([String: String].self, from: Data(retryJSON.utf8))
        assert(retryContext == context, "Retries reuse the same idempotent session ID")
        print("Focus session checks passed: pause, resume, expiry, extension, recovery, open-ended, bounds, persistence, completion deeplink.")
    }
}
