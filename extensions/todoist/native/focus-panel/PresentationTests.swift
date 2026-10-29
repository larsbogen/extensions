import AppKit

private final class PresentationTransport: TogglTransport {
    var calls = 0
    func send(_ request: URLRequest, completion: @escaping (TogglResponse<Data>) -> Void) {
        calls += 1
        assertionFailure("Presentation tests must never make network calls")
    }
}

struct PresentationTests {
    static func run() throws {
        var appearance = try JSONDecoder().decode(FocusAppearance.self, from: Data(#"{"fontSize":42,"width":700,"height":600,"x":12,"y":34}"#.utf8))
        assert(appearance.mode == .compact && appearance.size == FocusWindowSize(width: 360, height: 240))
        assert(appearance.fontSize == 42 && appearance.x == 12 && appearance.y == 34)
        appearance.size = FocusWindowSize(width: 340, height: 260)
        appearance.mode = .expanded
        assert(appearance.size == FocusWindowSize(width: 700, height: 600))
        appearance.size = FocusWindowSize(width: 800, height: 650)
        let restored = try JSONDecoder().decode(FocusAppearance.self, from: JSONEncoder().encode(appearance))
        assert(restored.mode == .expanded && restored.width == 800 && restored.height == 650)
        assert(restored.compactSize == FocusWindowSize(width: 340, height: 260))
        var resizing = FocusAppearance()
        resizing.recordResize(from: FocusWindowSize(width: 360, height: 320), to: FocusWindowSize(width: 400, height: 320))
        assert(resizing.size == FocusWindowSize(width: 400, height: 240), "Warning height must not be saved on width-only resize")
        resizing.recordResize(from: FocusWindowSize(width: 400, height: 320), to: FocusWindowSize(width: 400, height: 400))
        assert(resizing.size.height == 400, "An explicit height resize sets a new preferred height")
        let task = FocusTask(id: "test", title: "Test", url: "https://todoist.com/app/task/test", completionURL: "raycast://extensions/doist/todoist/complete-focused-task")
        var session = FocusSession(task: task, duration: 1500)
        session.elapsed = 42
        var writes = 0
        let transport = PresentationTransport()
        let coordinator = FocusCoordinator(snapshot: FocusSnapshot(session: session), client: TogglClient(transport: transport), write: { _ in writes += 1 })
        let before = try JSONEncoder().encode(coordinator.snapshot.session)
        let controller = FocusController(directory: URL(fileURLWithPath: "/unused"), lockDescriptor: -1)
        controller.coordinator = coordinator
        let content = controller.buildContent()
        for mode in [FocusViewMode.compact, .expanded] {
            for font in [20.0, 26, 34, 42] {
                for title in ["Kort tittel", String(repeating: "æøå 👩‍💻 Lang oppgavetittel ", count: 40)] {
                    coordinator.snapshot.appearance.mode = mode
                    coordinator.snapshot.appearance.fontSize = font
                    coordinator.snapshot.session?.task.title = title
                    content.frame = NSRect(x: 0, y: 0, width: mode == .compact ? 320 : 480, height: 900)
                    controller.render()
                    content.layoutSubtreeIfNeeded()
                    let minimum = controller.minimumSize
                    assert(minimum.width == (mode == .compact ? 320 : 420) && minimum.height.isFinite)
                    content.frame.size.height = max(240, minimum.height)
                    controller.layoutTitle()
                    content.layoutSubtreeIfNeeded()
                    assert(controller.contentStack.frame.height <= content.bounds.height - 54 + 1)
                    assert(!controller.pauseButton.isHidden)

                    assert(controller.titleLabel.stringValue == title && controller.titleLabel.accessibilityLabel() == title)
                    assert(controller.titleWidth.constant > 0 && controller.titleHeight.constant.isFinite)
                    assert(controller.progress.isHidden == (mode == .compact))
                    assert(controller.openButton.isHidden == (mode == .compact))
                    assert(controller.noticeStack.isHidden && controller.contentStack.detachesHiddenViews)
                    assert(controller.titleLabel.frame.height >= font)
                }
            }
            for phase in [FocusPhase.running, .paused, .finished, .ended] {
                coordinator.snapshot.session?.phase = phase
                controller.render()
                let model = controller.presentation!
                assert(controller.pauseButton.title == model.pauseTitle && controller.completeButton.isEnabled == model.canComplete)
                let menu = controller.makeActionsMenu()
                assert(menu.item(at: 0)?.title == (mode == .compact ? "Vis detaljer" : "Vis kompakt"))
                assert(menu.items.first { $0.action == #selector(FocusController.completeTask) }?.isEnabled == model.canComplete)
            }
        }
        coordinator.snapshot.session = session
        coordinator.snapshot.appearance.mode = .compact
        controller.render()
        assert(controller.actionMenu.accessibilityLabel() == "Handlinger for fokusoppgaven")
        assert(controller.handleShortcut("p", modifiers: .command) && coordinator.snapshot.session?.phase == .paused)
        assert(controller.handleShortcut("p", modifiers: .command) && coordinator.snapshot.session?.phase == .running)
        assert(!controller.handleShortcut("p", modifiers: [.command, .option]))
        coordinator.snapshot.session?.duration = 0
        controller.render()
        assert(!controller.makeActionsMenu().items.contains { $0.title == "+5 min" })
        assert(controller.captionLabel.stringValue == "aktiv tid")
        controller.isCompleting = true
        controller.render()
        assert(!controller.pauseButton.isEnabled && !controller.completeButton.isEnabled && !controller.noticeStack.isHidden)
        assert(controller.handleShortcut("+", modifiers: .command) && coordinator.snapshot.session?.duration == 0)
        controller.isCompleting = false
        controller.completionError = "Kunne ikke fullføre"
        controller.render()
        assert(!controller.retryButton.isHidden && controller.retryButton.isEnabled && controller.noticeLabel.stringValue.contains("Kunne ikke fullføre"))
        controller.completionError = nil
        coordinator.snapshot.tracking.message = "Venter på nett"
        controller.render()
        assert(!controller.detailsButton.isHidden && controller.noticeLabel.stringValue.contains("Venter på nett"))
        coordinator.snapshot.tracking.message = nil
        coordinator.snapshot.session = session
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let periods = try encoder.encode(coordinator.snapshot.tracking.periods)
        let count = writes
        controller.toggleViewMode()
        assert(coordinator.snapshot.appearance.mode == .expanded)
        controller.toggleViewMode()
        assert(coordinator.snapshot.appearance.mode == .compact)
        assert(writes == count)
        let after = try JSONEncoder().encode(coordinator.snapshot.session)
        let decoder = JSONDecoder()
        let beforeSession = try decoder.decode(FocusSession.self, from: before)
        let afterSession = try decoder.decode(FocusSession.self, from: after)
        assert(beforeSession.id == afterSession.id)
        let periodsAfter = try encoder.encode(coordinator.snapshot.tracking.periods)
        assert(coordinator.snapshot.session?.elapsed == 42 && periodsAfter == periods && !coordinator.busy && transport.calls == 0)
        let failing = FocusCoordinator(snapshot: FocusSnapshot(session: session), write: { _ in throw CocoaError(.fileWriteOutOfSpace) })
        assert(!failing.persist())
        let notice = FocusNotice.make(coordinator: failing, completing: false, completionError: nil)
        assert(notice.text.contains("Kunne ikke lagre") && notice.details)
        for sync in [PeriodSync.pending, .review, .uncertain] {
            let period = WorkPeriod(sessionID: session.id, task: task, start: 1, stop: 2, checkpoint: 2,
                                    description: task.title, sync: sync)
            coordinator.snapshot.tracking.periods = [period]
            controller.render()
            assert(!controller.noticeStack.isHidden && !controller.detailsButton.isHidden)
            if sync == .uncertain { assert(controller.noticeLabel.stringValue.contains("Stopp er ikke bekreftet")) }
            failing.snapshot.tracking.periods = [period]
        }
        let storageAndStop = FocusNotice.make(coordinator: failing, completing: false, completionError: "Fullføring feilet")
        assert(storageAndStop.text.contains("Kunne ikke lagre") && storageAndStop.text.contains("Stopp er ikke bekreftet") && storageAndStop.retry)
        let oldFrame = CGRect(x: 700, y: 300, width: 480, height: 600)
        let newFrame = FocusGeometry.frame(anchoredTo: oldFrame, size: CGSize(width: 360, height: 240))
        assert(newFrame.maxX == oldFrame.maxX && newFrame.maxY == oldFrame.maxY)
        print("Focus presentation checks passed: migration, sizes, modes, detached views, accessibility, actions and notices.")
    }
}
