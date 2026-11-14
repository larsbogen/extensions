import AppKit

private final class PresentationTransport: TogglTransport {
    var calls = 0
    func send(_ request: URLRequest, completion: @escaping (TogglResponse<Data>) -> Void) {
        calls += 1
        assertionFailure("Presentation tests must never make network calls")
    }
}

struct PresentationTests {
    private static func assertColor(_ actual: NSColor, equals expected: NSColor, in appearance: NSAppearance.Name) {
        NSAppearance(named: appearance)!.performAsCurrentDrawingAppearance {
            let actual = actual.usingColorSpace(.sRGB)!
            let expected = expected.usingColorSpace(.sRGB)!
            assert(abs(actual.redComponent - expected.redComponent) < 0.001)
            assert(abs(actual.greenComponent - expected.greenComponent) < 0.001)
            assert(abs(actual.blueComponent - expected.blueComponent) < 0.001)
            assert(abs(actual.alphaComponent - expected.alphaComponent) < 0.001)
        }
    }

    private static func assertVisible(_ view: NSView) {
        var ancestor: NSView? = view
        while let current = ancestor {
            assert(!current.isHidden, "\(type(of: view)) must remain visible in the focus card")
            ancestor = current.superview
        }
    }

    private static func isVisible(_ view: NSView) -> Bool {
        var ancestor: NSView? = view
        while let current = ancestor {
            if current.isHidden { return false }
            ancestor = current.superview
        }
        return true
    }

    private static func assertFitsCard(_ controller: FocusController, content: NSView, context: String) {
        let controls: [(String, NSView)] = [
            ("header menu", controller.actionMenu), ("project", controller.projectLabel),
            ("title area", controller.titleScroll), ("time ring", controller.progress),
            ("extend", controller.extendButton),
            ("complete", controller.completeButton),
            ("next task", controller.nextButton),
            ("notice", controller.noticeLabel), ("retry", controller.retryButton), ("details", controller.detailsButton),
            ("Toggl toggle", controller.togglToggle), ("Toggl project", controller.togglProject),
            ("Toggl status", controller.togglStatus), ("Toggl settings", controller.togglSettings),
            ("Toggl review", controller.togglReview), ("Toggl sync", controller.togglSync),
            ("open", controller.openButton), ("end", controller.endButton),
            ("duration", controller.durationPicker), ("width", controller.widthPicker), ("font", controller.fontPicker),
        ]
        let available = content.bounds.insetBy(dx: -0.5, dy: -0.5)
        for (name, view) in controls where isVisible(view) {
            assert(view.isDescendant(of: content), "\(context): visible \(name) is detached from the card")
            let frame = view.convert(view.bounds, to: content)
            assert(frame.width > 0 && frame.height > 0 && available.contains(frame),
                   "\(context): \(name) frame \(frame) escapes card bounds \(content.bounds); content stack \(controller.contentStack.frame)")
        }
        let ring = controller.progress.convert(controller.progress.bounds, to: content)
        assert(abs(ring.midX - content.bounds.midX) < 1,
               "\(context): ring center x=\(ring.midX) must match card center x=\(content.bounds.midX); ring \(ring), stack \(controller.contentStack.frame)")
    }

    // Optional review images use only detached views and synthetic data. Never
    // create an NSApplication or NSWindow, change system appearance, or open apps.
    private static func savePreviewsIfRequested() throws {
        guard let path = ProcessInfo.processInfo.environment["FOCUS_PANEL_PREVIEW_DIR"], !path.isEmpty else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let task = FocusTask(id: "preview", title: "Gå gjennom emnebeskrivelsene", url: "https://todoist.com/app/task/preview",
                             completionURL: "raycast://extensions/doist/todoist/complete-focused-task", projectName: "Studieadministrasjon")
        var session = FocusSession(task: task, duration: 1500)
        session.elapsed = 498
        session.togglEnabled = true
        var snapshot = FocusSnapshot(session: session)
        snapshot.tracking.settings.accountID = 1
        snapshot.tracking.settings.workspaceID = 1
        snapshot.tracking.settings.enabled = true
        snapshot.tracking.periods = [WorkPeriod(sessionID: session.id, task: task, start: 0, checkpoint: 498,
                                                description: task.title, sync: .running)]
        let transport = PresentationTransport()
        let coordinator = FocusCoordinator(snapshot: snapshot, client: TogglClient(transport: transport), write: { _ in
            assertionFailure("Preview rendering must not persist state")
        })
        let controller = FocusController(directory: URL(fileURLWithPath: "/unused"), lockDescriptor: -1)
        controller.coordinator = coordinator
        // Expired external starts are acknowledged without opening a window,
        // replacing a timer, or starting a tracking period. The controller is
        // deliberately detached and has no NSPanel in these tests.
        let requestEncoder = JSONEncoder()
        requestEncoder.outputFormatting = .sortedKeys
        let sessionBeforeExpiredStart = try requestEncoder.encode(coordinator.snapshot.session)
        let trackingBeforeExpiredStart = try requestEncoder.encode(coordinator.snapshot.tracking)
        for action in ["start", "start-queue"] {
            let expired = FocusRequest(id: "expired-\(action)", action: action, task: task,
                                       duration: 300, expiresAt: Date().timeIntervalSince1970 - 1)
            assert(controller.handleRequest(expired))
            assert(coordinator.snapshot.acknowledgedRequests.contains(expired.id))
            let sessionAfterExpiredStart = try requestEncoder.encode(coordinator.snapshot.session)
            let trackingAfterExpiredStart = try requestEncoder.encode(coordinator.snapshot.tracking)
            assert(sessionAfterExpiredStart == sessionBeforeExpiredStart)
            assert(trackingAfterExpiredStart == trackingBeforeExpiredStart)
            assert(transport.calls == 0)
        }
        let content = controller.buildContent()
        for (name, appearance, mode) in [("light", NSAppearance.Name.aqua, FocusViewMode.compact), ("dark", .darkAqua, .compact),
                                         ("details-light", .aqua, .expanded), ("details-dark", .darkAqua, .expanded)] {
            coordinator.snapshot.appearance.mode = mode
            content.appearance = NSAppearance(named: appearance)
            content.frame = NSRect(x: 0, y: 0, width: mode == .compact ? 360 : 420, height: 800)
            controller.render()
            content.layoutSubtreeIfNeeded()
            content.frame.size.height = max(500, controller.minimumSize.height)
            controller.layoutTitle()
            content.layoutSubtreeIfNeeded()
            assertFitsCard(controller, content: content, context: "\(name) native preview")
            guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else {
                throw NSError(domain: "FocusPreview", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not create detached-view bitmap"])
            }
            content.effectiveAppearance.performAsCurrentDrawingAppearance {
                content.cacheDisplay(in: content.bounds, to: bitmap)
            }
            guard let data = bitmap.representation(using: .png, properties: [:]) else {
                throw NSError(domain: "FocusPreview", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not encode detached-view PNG"])
            }
            try data.write(to: directory.appendingPathComponent("native-tidsring-\(name).png"))
        }
        assert(transport.calls == 0 && coordinator.snapshot.session?.elapsed == 498)
    }

    static func run() throws {
        assertColor(FocusTheme.background, equals: .white, in: .aqua)
        assertColor(FocusTheme.background, equals: NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.115, alpha: 1), in: .darkAqua)
        assertColor(FocusTheme.accent, equals: NSColor(srgbRed: 40.0 / 255, green: 115.0 / 255, blue: 92.0 / 255, alpha: 1), in: .aqua)
        assertColor(FocusTheme.accent, equals: .systemGreen, in: .darkAqua)
        assertColor(FocusTheme.pausedAccent, equals: .systemOrange, in: .darkAqua)
        // Alpha operations on system colors must resolve in the requested theme,
        // even when the shared color was first used in light mode.
        assertColor(FocusTheme.track, equals: NSColor(srgbRed: 242.0 / 255, green: 245.0 / 255, blue: 244.0 / 255, alpha: 1), in: .aqua)
        NSAppearance(named: .darkAqua)!.performAsCurrentDrawingAppearance {
            assertColor(FocusTheme.track, equals: NSColor.labelColor.withAlphaComponent(0.10), in: .darkAqua)
        }
        let ringBounds = NSRect(x: 0, y: 0, width: 178, height: 178)
        let quarter = FocusRingGeometry(bounds: ringBounds, progress: 0.25, hasTimeLimit: true)
        assert(abs(quarter.endPoint.x - ringBounds.midX - quarter.radius) < 0.001 && abs(quarter.endPoint.y - ringBounds.midY) < 0.001,
               "A quarter of the session moves the elapsed arc clockwise from twelve to three o'clock")
        for value in [-1.0, 0, 0.5, 1, 2, .infinity, -.infinity, .nan] {
            let geometry = FocusRingGeometry(bounds: ringBounds, progress: value, hasTimeLimit: true)
            assert(geometry.clampedProgress.isFinite && (0...1).contains(geometry.clampedProgress))
            assert(geometry.endPoint.x.isFinite && geometry.endPoint.y.isFinite)
            assert(FocusRingGeometry(bounds: ringBounds, progress: value, hasTimeLimit: false).clampedProgress == 0,
                   "An unlimited session must not show a fabricated elapsed fraction")
        }
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
        content.frame = NSRect(x: 0, y: 0, width: 360, height: 600)
        assert(content is FocusSurfaceView && content.appearance == nil && controller.progress.appearance == nil,
               "The content and ring must inherit appearance instead of forcing a theme")
        let themeEncoder = JSONEncoder()
        themeEncoder.outputFormatting = .sortedKeys
        let stateBeforeThemeChange = try themeEncoder.encode(coordinator.snapshot)
        let writesBeforeThemeChange = writes
        for name in [NSAppearance.Name.aqua, .darkAqua, .aqua] {
            content.appearance = NSAppearance(named: name)
            content.layoutSubtreeIfNeeded()
            controller.render()
            assert(controller.progress.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == name)
            assert(controller.titleLabel.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == name)
            let stateAfterThemeChange = try themeEncoder.encode(coordinator.snapshot)
            assert(stateAfterThemeChange == stateBeforeThemeChange,
                   "Appearance changes must leave the timer, queue, and tracking state intact")
            assert(writes == writesBeforeThemeChange && transport.calls == 0 && !coordinator.busy)
        }
        content.appearance = nil
        for mode in [FocusViewMode.compact, .expanded] {
            for font in [20.0, 26, 34, 42] {
                for title in ["Kort tittel", String(repeating: "æøå 👩‍💻 Lang oppgavetittel ", count: 40)] {
                    coordinator.snapshot.appearance.mode = mode
                    coordinator.snapshot.appearance.fontSize = font
                    coordinator.snapshot.session?.task.title = title
                    content.frame = NSRect(x: 0, y: 0, width: mode == .compact ? 320 : 420, height: 900)
                    controller.render()
                    content.layoutSubtreeIfNeeded()
                    let minimum = controller.minimumSize
                    assert(minimum.width == (mode == .compact ? 320 : 420) && minimum.height.isFinite)
                    content.frame.size.height = max(240, minimum.height)
                    controller.layoutTitle()
                    content.layoutSubtreeIfNeeded()
                    assertFitsCard(controller, content: content, context: "\(mode) font=\(font) titleLength=\(title.count)")
                    assert(controller.contentStack.frame.height <= content.bounds.height - 54 + 1)
                    assert(!controller.statusLabel.stringValue.uppercased().contains("TODOIST"))

                    assert(controller.titleLabel.stringValue == title && controller.titleLabel.accessibilityLabel() == title)
                    assert(controller.titleWidth.constant > 0 && controller.titleHeight.constant.isFinite)
                    assertVisible(controller.progress)
                    assertVisible(controller.completeButton)
                    assert(controller.completeButton.title == "Fullfør")
                    assert(controller.completeButton.style == .primary)
                    let completeFrame = controller.completeButton.convert(controller.completeButton.bounds, to: content)
                    let extendFrame = controller.extendButton.convert(controller.extendButton.bounds, to: content)
                    assert(abs(completeFrame.midY - extendFrame.midY) < 1 && completeFrame.maxX <= extendFrame.minX,
                           "Fullfør occupies the primary position beside +5 min")
                    func hasPauseButton(_ view: NSView) -> Bool {
                        if let button = view as? NSButton, let action = button.action,
                           [#selector(FocusController.togglePause), #selector(FocusController.takeBreak)].contains(action) { return true }
                        return view.subviews.contains(where: hasPauseButton)
                    }
                    assert(!hasPauseButton(content), "Pause controls belong only in the menu")
                    assert(controller.completeButton.action == #selector(FocusController.completeTask))
                    assert(controller.completeButton.keyEquivalent == "\r" && controller.completeButton.keyEquivalentModifierMask == .command)
                    assert(controller.progress.hasTimeLimit && abs(controller.progress.geometry.clampedProgress - 42.0 / 1500) < 0.001)
                    assert(controller.progress.bounds.width >= 170 && controller.progress.bounds.height >= 170)
                    assert(controller.openButton.isHidden == (mode == .compact))
                    assert(controller.noticeStack.isHidden && controller.contentStack.detachesHiddenViews)
                    assert(controller.titleLabel.frame.height >= font)
                }
            }
            for phase in [FocusPhase.running, .paused, .finished, .ended] {
                coordinator.snapshot.session?.phase = phase
                controller.render()
                let model = controller.presentation!
                assert(controller.completeButton.isEnabled == model.canComplete)
                let menu = controller.makeActionsMenu()
                let pause = menu.item(at: 0)!
                assert(pause.title == model.pauseTitle && pause.action == #selector(FocusController.togglePause))
                assert(pause.target === controller && pause.isEnabled == model.canPause)
                assert(pause.keyEquivalent == "p" && pause.keyEquivalentModifierMask == .command)
                assert(menu.items.first { $0.action == #selector(FocusController.toggleViewMode) }?.title == (mode == .compact ? "Vis detaljer" : "Vis kompakt"))
                assert(menu.items.first { $0.action == #selector(FocusController.completeTask) }?.isEnabled == model.canComplete)
            }
        }
        coordinator.snapshot.session = session
        coordinator.snapshot.appearance.mode = .compact
        controller.render()
        assert(controller.actionMenu.accessibilityLabel() == "Handlinger for fokusoppgaven")
        assert(controller.handleShortcut("p", modifiers: .command) && coordinator.snapshot.session?.phase == .paused)
        assert(controller.makeActionsMenu().item(at: 0)?.title == "Fortsett")
        assert(controller.handleShortcut("p", modifiers: .command) && coordinator.snapshot.session?.phase == .running)
        assert(controller.makeActionsMenu().item(at: 0)?.title == "Pause")
        assert(!controller.handleShortcut("p", modifiers: [.command, .option]))
        coordinator.snapshot.session?.duration = 0
        controller.render()
        assert(!controller.makeActionsMenu().items.contains { $0.title == "+5 min" })
        assert(controller.captionLabel.stringValue == "aktiv tid")
        assert(!controller.progress.hasTimeLimit && controller.progress.geometry.clampedProgress == 0)
        assert(controller.extendButton.isHidden)
        coordinator.snapshot.session?.elapsed = 86400
        controller.render()
        content.layoutSubtreeIfNeeded()
        let longClockFrame = controller.clockLabel.convert(controller.clockLabel.bounds, to: controller.progress)
        assert(controller.clockLabel.stringValue == "24:00:00" && controller.progress.bounds.contains(longClockFrame),
               "Long active-time clocks must fit inside the ring")
        coordinator.snapshot.session?.elapsed = 42
        controller.isCompleting = true
        controller.render()
        assert(controller.makeActionsMenu().item(at: 0)?.isEnabled == false && !controller.completeButton.isEnabled && !controller.noticeStack.isHidden)
        assert(!controller.noticeLabel.stringValue.contains("Todoist") && !controller.hintLabel.stringValue.contains("Todoist"))
        assertVisible(controller.completeButton)
        assert(controller.completeButton.title == "Fullfører …")
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
        // Extra controls and notices must fit at the advertised minimum width too.
        do {
            var queued = session
            queued.task.queue = FocusQueueContext(accountId: "owner", day: "2026-11-02", entryId: "layout", revision: 1)
            queued.task.projectName = "Studieadministrasjon"
            queued.togglEnabled = true
            var snapshot = FocusSnapshot(session: queued)
            snapshot.tracking.settings.accountID = 1
            snapshot.tracking.settings.workspaceID = 1
            snapshot.tracking.settings.enabled = true
            let engine = FocusCoordinator(snapshot: snapshot, client: TogglClient(transport: transport), write: { _ in })
            let view = FocusController(directory: URL(fileURLWithPath: "/unused"), lockDescriptor: -1)
            view.coordinator = engine
            let content = view.buildContent()
            for mode in [FocusViewMode.compact, .expanded] {
                for state in ["running", "completing", "error", "completed"] {
                    engine.snapshot.appearance.mode = mode
                    engine.snapshot.session?.phase = state == "completed" ? .ended : .running
                    engine.snapshot.session?.queueCompleted = state == "completed"
                    view.isCompleting = state == "completing"
                    view.completionError = state == "error" ? "Kunne ikke fullføre oppgaven. Prøv igjen når forbindelsen er tilbake." : nil
                    content.frame = NSRect(x: 0, y: 0, width: mode == .compact ? 320 : 420, height: 1000)
                    view.render()
                    content.layoutSubtreeIfNeeded()
                    content.frame.size.height = view.minimumSize.height
                    view.layoutTitle()
                    content.layoutSubtreeIfNeeded()
                    assertFitsCard(view, content: content, context: "connected queue \(mode) \(state)")
                }
            }
        }
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("focus-queue-view-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: directory) }
            var queued = session
            queued.task.queue = FocusQueueContext(accountId: "owner", day: "2026-10-30", entryId: "a", revision: 1)
            queued.task.nextURL = "raycast://extensions/doist/todoist/next-focus-task"
            queued.phase = .paused
            let engine = FocusCoordinator(snapshot: FocusSnapshot(session: queued), client: TogglClient(transport: transport), write: { _ in })
            let view = FocusController(directory: directory, lockDescriptor: -1)
            view.coordinator = engine
            let content = view.buildContent()
            content.frame = NSRect(x: 0, y: 0, width: 360, height: 800)
            view.render()
            assert(!view.queueRow.isHidden && view.nextButton.isEnabled)
            engine.snapshot.session?.phase = .finished
            view.render()
            assert(view.makeActionsMenu().item(at: 0)?.title == "Fortsett")
            assert(view.makeActionsMenu().items.contains { $0.action == #selector(FocusController.takeBreak) && $0.isEnabled })
            engine.snapshot.session?.phase = .paused
            view.render()
            view.isCompleting = true
            let automaticStop = FocusRequest(id: "auto-missing-task", action: "stop", taskId: queued.task.id, sessionId: queued.id, automatic: true)
            assert(view.handleRequest(automaticStop))
            assert(engine.snapshot.session?.phase == .paused && !view.isHiddenForSync,
                   "A cache update from completing the task must not hide the queued card")
            let result = FocusCompletionResult(sessionId: queued.id, success: true)
            try JSONEncoder().encode(result).write(to: directory.appendingPathComponent("completion.json"))
            view.consumeCompletion()
            assert(engine.snapshot.session?.phase == .ended && engine.snapshot.session?.queueCompleted == true)
            assert(!view.isHiddenForSync && view.nextButton.title == "Start neste" && view.makeActionsMenu().item(at: 0)?.isEnabled == false)
            assert(view.nextButton.isEnabled && !view.endButton.isHidden)
            engine.snapshot.session?.pendingNextRequestId = "pending"
            view.render()
            assert(!view.nextButton.isEnabled && !view.completeButton.isEnabled && !view.endButton.isEnabled)
            assert(view.makeActionsMenu().item(at: 0)?.isEnabled == false)
            engine.snapshot.session?.pendingNextRequestId = nil
            engine.snapshot.session?.queueFinished = true
            view.render()
            assert(!view.nextButton.isEnabled && view.noticeLabel.stringValue.contains("Ingen flere oppgaver"))
            assert(engine.end(clearQueue: true))
            assert(engine.snapshot.session?.task.queue == nil, "Explicit unfocus ends the queue; automatic completion cleanup does not")
        }
        let oldFrame = CGRect(x: 700, y: 300, width: 480, height: 600)
        let newFrame = FocusGeometry.frame(anchoredTo: oldFrame, size: CGSize(width: 360, height: 240))
        assert(newFrame.maxX == oldFrame.maxX && newFrame.maxY == oldFrame.maxY)
        try savePreviewsIfRequested()
        print("Focus presentation checks passed: migration, sizes, modes, time ring, automatic themes, detached views, accessibility, actions and notices.")
    }
}
