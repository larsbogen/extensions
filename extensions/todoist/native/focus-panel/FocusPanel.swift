import AppKit
import Darwin

final class FocusPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class TitleDocument: NSView {
    override var isFlipped: Bool { true }
}

final class DragLabel: NSTextField {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
}

final class ResizeGrip: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.tertiaryLabelColor.setStroke()
        for inset in stride(from: 4, through: 12, by: 4) {
            let line = NSBezierPath()
            line.move(to: NSPoint(x: bounds.maxX - CGFloat(inset), y: 3))
            line.line(to: NSPoint(x: bounds.maxX - 3, y: CGFloat(inset)))
            line.stroke()
        }
    }
    override func mouseDown(with event: NSEvent) {
        guard let window = window else { return }
        let start = NSEvent.mouseLocation
        let frame = window.frame
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            if next.type == .leftMouseUp { break }
            let point = NSEvent.mouseLocation
            let width = min(window.maxSize.width, max(window.minSize.width, frame.width + point.x - start.x))
            let height = min(window.maxSize.height, max(window.minSize.height, frame.height - point.y + start.y))
            window.setFrame(NSRect(x: frame.minX, y: frame.maxY - height, width: width, height: height), display: true)
        }
    }
}

final class ProgressTrack: NSView {
    var progress: Double = 0 { didSet { needsDisplay = true } }
    var tint = NSColor.systemGreen { didSet { needsDisplay = true } }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.labelColor.withAlphaComponent(0.10).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 3, yRadius: 3).fill()
        tint.setFill()
        let fill = NSRect(x: 0, y: 0, width: bounds.width * progress, height: bounds.height)
        NSBezierPath(roundedRect: fill, xRadius: 3, yRadius: 3).fill()
    }
}

final class FocusController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let directory: URL
    let lockDescriptor: Int32
    var coordinator: FocusCoordinator!
    var snapshot: FocusSnapshot {
        get { coordinator.snapshot }
        set { coordinator.snapshot = newValue }
    }
    var settingsWindow: TogglSettingsWindow?
    var isHiddenForSync = false
    var isProcessingRequests = false
    let togglToggle = NSButton(checkboxWithTitle: "Registrer i Toggl", target: nil, action: nil)
    let togglProject = NSPopUpButton()
    let togglStatus = NSTextField(wrappingLabelWithString: "")
    let activeTimeLabel = NSTextField(labelWithString: "")
    let togglSettings = NSButton(title: "Koble til Toggl", target: nil, action: nil)
    let togglReview = NSButton(title: "Se gjennom", target: nil, action: nil)
    let togglSync = NSButton(title: "Synkroniser", target: nil, action: nil)
    var togglControls: NSStackView!
    var fixedContentHeight: CGFloat { max(314, contentStack.fittingSize.height - titleAreaHeight.constant + 62) }

    var panel: FocusPanel!
    var ticker: Timer?
    var previousTick = ProcessInfo.processInfo.systemUptime
    var lastSave = ProcessInfo.processInfo.systemUptime
    var requestData: Data?
    var isLayingOut = false
    var lastTitleWidth: CGFloat = 0
    var isCompleting = false
    var completionStarted: TimeInterval = 0
    var completionError: String?
    let titleLabel = DragLabel(wrappingLabelWithString: "")
    let statusLabel = DragLabel(labelWithString: "FOKUS · TODOIST")
    let clockLabel = NSTextField(labelWithString: "25:00")
    let captionLabel = NSTextField(labelWithString: "igjen")
    let hintLabel = NSTextField(wrappingLabelWithString: "")
    let progress = ProgressTrack()
    let pauseButton = NSButton(title: "Pause", target: nil, action: nil)
    let openButton = NSButton(title: "Åpne oppgave", target: nil, action: nil)
    let endButton = NSButton(title: "Avslutt økt", target: nil, action: nil)
    let completeButton = NSButton(title: "Fullfør oppgave", target: nil, action: nil)
    let extendButton = NSButton(title: "+5 min", target: nil, action: nil)
    let fontPicker = NSPopUpButton()
    let durationPicker = NSPopUpButton()
    let widthPicker = NSPopUpButton()
    let positionPicker = NSPopUpButton(frame: .zero, pullsDown: true)
    let titleScroll = NSScrollView()
    var titleHeight: NSLayoutConstraint!
    var titleWidth: NSLayoutConstraint!
    var titleAreaHeight: NSLayoutConstraint!
    var contentStack: NSStackView!

    init(directory: URL, lockDescriptor: Int32) {
        self.directory = directory
        self.lockDescriptor = lockDescriptor
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let store = FocusStore(directory: directory)
        do {
            let saved = try store.load() ?? FocusSnapshot()
            coordinator = FocusCoordinator(snapshot: saved, write: store.save)
            coordinator.restore()
        } catch {
            let alert = NSAlert()
            alert.messageText = "Kunne ikke lese fokusdata"
            alert.informativeText = "Den lagrede filen er bevart. Kontroller state.json i fokusmappen før du prøver igjen."
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        buildPanel()
        coordinator.onChange = { [weak self] in
            guard let self = self else { return }
            self.render()
            self.finishBackgroundIfPossible()
        }
        consumeRequest()
        if snapshot.session == nil {
            NSApp.terminate(nil)
            return
        }
        render()
        if !isHiddenForSync { panel.orderFrontRegardless() }
        save()
        coordinator.requestSync()
        ticker = Timer(timeInterval: 0.5, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        ticker?.tolerance = 0.1
        RunLoop.main.add(ticker!, forMode: .common)
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(self, selector: #selector(suspend), name: NSWorkspace.willSleepNotification, object: nil)
        workspace.addObserver(self, selector: #selector(wake), name: NSWorkspace.didWakeNotification, object: nil)
        workspace.addObserver(self, selector: #selector(screenChanged), name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(screenChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(suspend), name: NSNotification.Name("com.apple.screenIsLocked"), object: nil)
    }

    func button(_ button: NSButton, _ action: Selector) {
        button.target = self
        button.action = action
        button.bezelStyle = .rounded
        button.font = .systemFont(ofSize: 14, weight: .medium)
        button.setAccessibilityLabel(button.title)
    }

    func buildPanel() {
        let appearance = snapshot.appearance
        panel = FocusPanel(contentRect: NSRect(x: 0, y: 0, width: appearance.width, height: appearance.height),
                           styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
                           backing: .buffered, defer: false)
        panel.title = "Todoist Fokus"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.backgroundColor = NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.115, alpha: 1)
        panel.minSize = NSSize(width: 420, height: 390)
        panel.maxSize = NSSize(width: 1200, height: 1000)
        panel.delegate = self
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.closeButton)?.toolTip = "Lukk vinduet og sett økten på pause"

        // An opaque surface keeps the small controls readable over bright work apps.
        let backdrop = NSView()
        panel.contentView = backdrop
        let grip = ResizeGrip()
        grip.translatesAutoresizingMaskIntoConstraints = false
        grip.toolTip = "Dra for å endre størrelsen på fokusvinduet"
        backdrop.addSubview(grip)
        NSLayoutConstraint.activate([
            grip.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor, constant: -4),
            grip.bottomAnchor.constraint(equalTo: backdrop.bottomAnchor, constant: -4),
            grip.widthAnchor.constraint(equalToConstant: 20), grip.heightAnchor.constraint(equalToConstant: 20),
        ])

        statusLabel.font = .systemFont(ofSize: 11, weight: .bold)
        statusLabel.textColor = .systemGreen
        titleLabel.font = .systemFont(ofSize: appearance.fontSize, weight: .semibold)
        titleLabel.maximumNumberOfLines = 0
        titleLabel.lineBreakMode = .byWordWrapping
        titleLabel.isSelectable = false
        titleLabel.setContentCompressionResistancePriority(.required, for: .vertical)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        let document = TitleDocument()
        document.addSubview(titleLabel)
        titleWidth = titleLabel.widthAnchor.constraint(equalToConstant: 430)
        titleHeight = titleLabel.heightAnchor.constraint(equalToConstant: 70)
        NSLayoutConstraint.activate([
            titleLabel.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            titleLabel.topAnchor.constraint(equalTo: document.topAnchor), titleWidth, titleHeight,
        ])
        titleScroll.documentView = document
        titleScroll.drawsBackground = false
        titleScroll.hasVerticalScroller = true
        titleScroll.autohidesScrollers = true
        titleAreaHeight = titleScroll.heightAnchor.constraint(equalToConstant: 80)
        titleAreaHeight.isActive = true
        titleScroll.setAccessibilityLabel("Hele oppgavetittelen")

        clockLabel.font = .monospacedDigitSystemFont(ofSize: 46, weight: .medium)
        clockLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        captionLabel.font = .systemFont(ofSize: 13)
        captionLabel.textColor = .secondaryLabelColor
        let timeLabels = NSStackView(views: [clockLabel, captionLabel])
        timeLabels.orientation = .horizontal
        timeLabels.alignment = .firstBaseline
        timeLabels.spacing = 8
        button(extendButton, #selector(extendSession))
        let timeRow = row([timeLabels, spacer(), extendButton])
        progress.heightAnchor.constraint(equalToConstant: 6).isActive = true

        button(pauseButton, #selector(togglePause))
        button(openButton, #selector(openTask))
        button(endButton, #selector(endSession))
        button(completeButton, #selector(completeTask))
        pauseButton.keyEquivalent = "p"
        pauseButton.keyEquivalentModifierMask = [.command]
        pauseButton.toolTip = "Pause eller fortsett (⌘P)"
        extendButton.keyEquivalent = "+"
        extendButton.keyEquivalentModifierMask = [.command]
        completeButton.keyEquivalent = "\r"
        completeButton.keyEquivalentModifierMask = [.command]
        completeButton.contentTintColor = .systemGreen
        completeButton.toolTip = "Fullfør oppgaven i Todoist og stopp fokuset"
        let actions = row([pauseButton, openButton, spacer(), endButton])
        let completionRow = row([completeButton, spacer()])
        hintLabel.font = .systemFont(ofSize: 12)
        hintLabel.textColor = .secondaryLabelColor
        hintLabel.maximumNumberOfLines = 2

        fontPicker.addItems(withTitles: ["Tekst: 20", "Tekst: 26", "Tekst: 34", "Tekst: 42"])
        fontPicker.target = self
        fontPicker.action = #selector(changeFont)
        fontPicker.setAccessibilityLabel("Tekststørrelse i fokusvinduet")
        fontPicker.toolTip = "Endrer bare dette fokusvinduet"
        durationPicker.addItems(withTitles: ["15 min", "25 min", "50 min", "Ubegrenset"])
        durationPicker.target = self
        durationPicker.action = #selector(changeDuration)
        durationPicker.setAccessibilityLabel("Øktlengde")
        widthPicker.addItems(withTitles: ["Bredde: 420", "Bredde: 480", "Bredde: 640", "Bredde: 800"])
        widthPicker.target = self
        widthPicker.action = #selector(changeWidth)
        widthPicker.setAccessibilityLabel("Bredde på fokusvinduet")
        let options = row([durationPicker, widthPicker, spacer(), fontPicker])

        positionPicker.addItems(withTitles: ["Flytt", "Øverst til venstre", "Øverst til høyre", "Nederst til venstre", "Nederst til høyre", "Midt på skjermen"])
        positionPicker.target = self
        positionPicker.action = #selector(movePanel)
        positionPicker.setAccessibilityLabel("Flytt fokusvinduet")
        let header = row([statusLabel, spacer(), positionPicker])
        button(togglSettings, #selector(openTogglSettings))
        button(togglReview, #selector(reviewToggl))
        button(togglSync, #selector(syncToggl))
        for control in [togglSettings, togglReview, togglSync] {
            control.font = .systemFont(ofSize: 12, weight: .medium)
        }
        togglToggle.target = self
        togglToggle.action = #selector(toggleToggl)
        togglToggle.setAccessibilityLabel("Registrer arbeidstid i Toggl")
        togglProject.target = self
        togglProject.action = #selector(changeTogglProject)
        togglProject.setAccessibilityLabel("Toggl-prosjekt")
        togglProject.widthAnchor.constraint(lessThanOrEqualToConstant: 200).isActive = true
        togglControls = row([togglToggle, spacer(), togglProject])
        togglStatus.font = .systemFont(ofSize: 12)
        togglStatus.textColor = .secondaryLabelColor
        togglStatus.setContentCompressionResistancePriority(.required, for: .vertical)
        activeTimeLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
        let togglActions = row([togglSettings, togglReview, spacer(), togglSync])
        contentStack = NSStackView(views: [header, titleScroll, timeRow, activeTimeLabel, progress, completionRow, actions, hintLabel, togglControls, togglStatus, togglActions, options])
        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 14
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        backdrop.addSubview(contentStack)
        NSLayoutConstraint.activate([
            contentStack.topAnchor.constraint(equalTo: backdrop.topAnchor, constant: 34),
            contentStack.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor, constant: 24),
            contentStack.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor, constant: -24),
            contentStack.bottomAnchor.constraint(lessThanOrEqualTo: backdrop.bottomAnchor, constant: -20),
        ])
        for view in [header, titleScroll, timeRow, activeTimeLabel, progress, completionRow, actions, hintLabel, togglControls!, togglStatus, togglActions, options] {
            view.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
        }
        if let x = appearance.x, let y = appearance.y {
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        } else if let screen = NSScreen.main {
            let frame = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: frame.maxX - panel.frame.width - 28, y: frame.maxY - panel.frame.height - 28))
        }
        constrainToScreen()
    }

    func row(_ views: [NSView]) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 8
        return stack
    }

    func spacer() -> NSView {
        let view = NSView()
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return view
    }

    func render() {
        guard let session = snapshot.session else { return }
        titleLabel.stringValue = session.task.title
        titleLabel.setAccessibilityLabel(session.task.title)
        let total = Int(ceil(session.duration > 0 ? session.remaining : session.elapsed))
        clockLabel.stringValue = total >= 3600
            ? String(format: "%d:%02d:%02d", total / 3600, (total / 60) % 60, total % 60)
            : String(format: "%02d:%02d", total / 60, total % 60)
        clockLabel.setAccessibilityLabel("\(clockLabel.stringValue) \(session.duration > 0 ? "igjen" : "aktiv tid")")
        progress.progress = session.progress
        progress.tint = session.phase == .paused ? .systemOrange : .systemGreen
        statusLabel.textColor = progress.tint
        captionLabel.stringValue = session.duration > 0 ? "igjen" : "aktiv tid"
        switch session.phase {
        case .running:
            statusLabel.stringValue = "FOKUS · TODOIST"
            pauseButton.title = "Pause"
            hintLabel.stringValue = "Dra i tittelen for å flytte kortet. Størrelsen velger du nedenfor."
        case .paused:
            statusLabel.stringValue = "PÅ PAUSE · TODOIST"
            pauseButton.title = "Fortsett"
            hintLabel.stringValue = "Tiden står stille. Fortsett når du er klar."
        case .finished:
            statusLabel.stringValue = "ØKTEN ER FERDIG"
            pauseButton.title = "Ny økt"
            hintLabel.stringValue = "Ta en pause, eller fortsett i fem minutter til."
        case .ended:
            statusLabel.stringValue = "ØKTEN ER AVSLUTTET"
            pauseButton.title = "Ny økt"
            hintLabel.stringValue = "Start en ny økt når du er klar."
        }
        pauseButton.setAccessibilityLabel(pauseButton.title)
        completeButton.title = isCompleting ? "Fullfører …" : "Fullfør oppgave"
        completeButton.setAccessibilityLabel(completeButton.title)
        completeButton.isEnabled = !isCompleting && session.phase != .ended && session.task.completionURL != nil
        for control in [pauseButton, extendButton, endButton, durationPicker] { control.isEnabled = !isCompleting }
        if isCompleting {
            hintLabel.stringValue = "Fullfører oppgaven i Todoist. Timeren er satt på pause."
        } else if let error = completionError {
            hintLabel.stringValue = error
        }
        extendButton.isHidden = session.duration == 0
        fontPicker.selectItem(at: [20.0, 26, 34, 42].firstIndex(of: snapshot.appearance.fontSize) ?? 1)
        let widths = [420.0, 480, 640, 800]
        if let index = widths.firstIndex(where: { abs($0 - panel.frame.width) < 1 }) {
            if widthPicker.numberOfItems > 4 { widthPicker.removeItem(at: 4) }
            widthPicker.selectItem(at: index)
        } else {
            if widthPicker.numberOfItems == 4 { widthPicker.addItem(withTitle: "") }
            widthPicker.item(at: 4)?.title = "Bredde: \(Int(panel.frame.width))"
            widthPicker.selectItem(at: 4)
        }
        let durations = [900.0, 1500, 3000, 0]
        if let index = durations.firstIndex(of: session.duration) {
            if durationPicker.numberOfItems > 4 { durationPicker.removeItem(at: 4) }
            durationPicker.selectItem(at: index)
        } else {
            if durationPicker.numberOfItems == 4 { durationPicker.addItem(withTitle: "") }
            durationPicker.item(at: 4)?.title = "\(Int(session.duration / 60)) min"
            durationPicker.selectItem(at: 4)
        }
        let connected = snapshot.tracking.settings.accountID != nil
        togglSettings.title = connected ? "Toggl-innstillinger" : "Koble til Toggl"
        togglSettings.setAccessibilityLabel(togglSettings.title)
        togglControls.isHidden = !connected
        togglStatus.isHidden = !connected && snapshot.tracking.periods.allSatisfy { $0.accountID == nil }
        togglStatus.stringValue = coordinator.status
        togglStatus.setAccessibilityLabel(coordinator.status)
        togglToggle.state = coordinator.trackingEnabled ? .on : .off
        togglToggle.isEnabled = !isCompleting
        togglProject.isEnabled = !isCompleting
        togglSync.isHidden = !connected
        togglSync.isEnabled = !coordinator.busy
        togglReview.isEnabled = !coordinator.busy
        togglReview.isHidden = coordinator.reviewPeriods.isEmpty && snapshot.tracking.takeover?.issue == nil
        let projects = snapshot.tracking.settings.availableProjects
        let titles = ["Uten prosjekt"] + projects.map(\.name)
        if togglProject.itemTitles != titles { togglProject.removeAllItems(); togglProject.addItems(withTitles: titles) }
        let selected = snapshot.tracking.settings.project(for: session.task)
        if let selected = selected, let index = projects.firstIndex(where: { $0.id == selected }) {
            togglProject.selectItem(at: index + 1)
        } else if selected != nil {
            togglProject.addItem(withTitle: "Prosjekt utilgjengelig")
            togglProject.selectItem(at: togglProject.numberOfItems - 1)
        } else { togglProject.selectItem(at: 0) }
        let seconds = max(0, Int(session.elapsed))
        activeTimeLabel.stringValue = String(format: "Arbeidstid i økten: %d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
        activeTimeLabel.setAccessibilityLabel(activeTimeLabel.stringValue)
        let minimum = fixedContentHeight + 64
        panel.minSize = NSSize(width: 420, height: min(800, minimum))
        if panel.frame.height < panel.minSize.height {
            var frame = panel.frame
            frame.origin.y -= panel.minSize.height - frame.height
            frame.size.height = panel.minSize.height
            panel.setFrame(frame, display: true)
            constrainToScreen()
        }
        layoutTitle()
    }

    func layoutTitle() {
        guard !isLayingOut else { return }
        isLayingOut = true
        defer { isLayingOut = false }
        let width = max(330, panel.frame.width - 64)
        let font = NSFont.systemFont(ofSize: snapshot.appearance.fontSize, weight: .semibold)
        titleLabel.font = font
        let height = ceil((titleLabel.stringValue as NSString).boundingRect(
            with: NSSize(width: width, height: 10000), options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font]).height) + 8
        titleWidth.constant = width
        titleHeight.constant = max(font.pointSize + 8, height)
        // Grow to show normal titles in full; unusually long titles remain scrollable.
        let available = max(64, panel.frame.height - fixedContentHeight)
        titleAreaHeight.constant = min(max(64, height), available)
        titleScroll.documentView?.setFrameSize(NSSize(width: width, height: max(height, titleAreaHeight.constant)))
        if lastTitleWidth != width {
            titleLabel.preferredMaxLayoutWidth = width
            lastTitleWidth = width
        }
    }

    func growForTitle(fit: Bool = false) {
        let width = max(330, panel.frame.width - 64)
        let font = NSFont.systemFont(ofSize: snapshot.appearance.fontSize, weight: .semibold)
        let height = ceil((titleLabel.stringValue as NSString).boundingRect(
            with: NSSize(width: width, height: 10000), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font]).height) + 8
        let limit = min(800, (panel.screen ?? NSScreen.main)?.visibleFrame.height ?? 800)
        let needed = min(limit, max(panel.minSize.height, height + fixedContentHeight))
        if needed > panel.frame.height || fit {
            var frame = panel.frame
            frame.origin.y -= needed - frame.height
            frame.size.height = needed
            panel.setFrame(frame, display: true)
            constrainToScreen()
        }
        layoutTitle()
    }

    func updateElapsed() {
        let oldPhase = snapshot.session?.phase
        coordinator.advance()
        if oldPhase == .running && snapshot.session?.phase != .running { coordinator.requestSync() }
        if oldPhase == .running && snapshot.session?.phase == .finished {
            NSSound(named: "Glass")?.play()
            if !isHiddenForSync { panel.orderFrontRegardless() }
        }
    }

    @objc func tick() {
        updateElapsed()
        consumeRequest()
        consumeCompletion()
        render()
        if snapshot.session?.phase == .running && ProcessInfo.processInfo.systemUptime - lastSave >= 5 { save() }
        coordinator.retryIfDue()
        finishBackgroundIfPossible()
    }

    func consumeRequest() {
        isProcessingRequests = true
        defer { isProcessingRequests = false; finishBackgroundIfPossible() }
        let inbox = directory.appendingPathComponent("requests")
        let queued = ((try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        for file in queued {
            guard let data = try? Data(contentsOf: file), let request = try? JSONDecoder().decode(FocusRequest.self, from: data) else { continue }
            if handleRequest(request) { try? FileManager.default.removeItem(at: file) }
        }
        // Read the previous single-file protocol for older clients and local previews.
        if let data = try? Data(contentsOf: directory.appendingPathComponent("request.json")), data != requestData,
           let request = try? JSONDecoder().decode(FocusRequest.self, from: data), handleRequest(request) {
            requestData = data
            try? FileManager.default.removeItem(at: directory.appendingPathComponent("request.json"))
        }
    }

    func acknowledge(_ request: FocusRequest) -> Bool {
        let previousID = snapshot.requestId
        let previousAcknowledgements = snapshot.acknowledgedRequests
        snapshot.requestId = request.id
        snapshot.acknowledgedRequests.append(request.id)
        snapshot.acknowledgedRequests = Array(snapshot.acknowledgedRequests.suffix(256))
        if coordinator.persist() { return true }
        snapshot.requestId = previousID
        snapshot.acknowledgedRequests = previousAcknowledgements
        return false
    }

    func handleRequest(_ request: FocusRequest) -> Bool {
        if request.id == snapshot.requestId || snapshot.acknowledgedRequests.contains(request.id) { return true }
        if request.action == "start", let task = request.task, !task.id.isEmpty, !task.title.isEmpty {
            isHiddenForSync = false
            let previousID = snapshot.session?.id
            guard coordinator.start(task: task, duration: request.duration ?? 1500) else { return false }
            if previousID != snapshot.session?.id {
                isCompleting = false
                completionError = nil
            }
        } else if request.action == "stop" {
            if let sessionId = request.sessionId, sessionId != snapshot.session?.id { return acknowledge(request) }
            if request.taskId == nil || request.taskId == snapshot.session?.task.id {
                guard coordinator.end(), acknowledge(request) else { return false }
                hideForSync()
                return true
            }
            // A late stop for the previous task must not affect the new card.
            return acknowledge(request)
        } else if request.action != "show" { return false }
        guard acknowledge(request) else { return false }
        render()
        growForTitle()
        isHiddenForSync = false
        panel.orderFrontRegardless()
        save()
        return true
    }

    @objc func togglePause() {
        coordinator.togglePause()
        render()
    }

    @objc func extendSession() {
        coordinator.editSession { $0.extend() }
        render()
    }

    @objc func changeFont() {
        snapshot.appearance.fontSize = [20.0, 26, 34, 42][fontPicker.indexOfSelectedItem]
        render()
        growForTitle(fit: true)
        save()
    }

    @objc func changeWidth() {
        let widths = [420.0, 480, 640, 800]
        guard widths.indices.contains(widthPicker.indexOfSelectedItem) else { return }
        var frame = panel.frame
        let width = widths[widthPicker.indexOfSelectedItem]
        frame.origin.x -= width - frame.width
        frame.size.width = width
        panel.setFrame(frame, display: true)
        constrainToScreen()
        render()
        growForTitle(fit: true)
        save()
    }

    @objc func movePanel() {
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let area = screen.visibleFrame.insetBy(dx: 24, dy: 24)
        let index = positionPicker.indexOfSelectedItem
        let x = [1, 3].contains(index) ? area.minX : area.maxX - panel.frame.width
        let y = [1, 2].contains(index) ? area.maxY - panel.frame.height : area.minY
        panel.setFrameOrigin(index == 5
            ? NSPoint(x: area.midX - panel.frame.width / 2, y: area.midY - panel.frame.height / 2)
            : NSPoint(x: x, y: y))
        constrainToScreen()
        save()
    }

    @objc func changeDuration() {
        let durations = [900.0, 1500, 3000, 0]
        guard durations.indices.contains(durationPicker.indexOfSelectedItem) else { return }
        coordinator.editSession { $0.setDuration(durations[durationPicker.indexOfSelectedItem]) }
        render()
        save()
    }

    @objc func openTask() {
        guard let string = snapshot.session?.task.url, let url = URL(string: string),
              url.scheme == "https", url.host == "todoist.com" else { return }
        NSWorkspace.shared.open(url)
    }

    @objc func completeTask() {
        guard !isCompleting, let session = snapshot.session, session.phase != .ended,
              let url = session.completionDeeplink else { return }
        guard coordinator.pause() else { return }
        completionError = nil
        // Discard the previous failure before retrying this same idempotent completion.
        try? FileManager.default.removeItem(at: directory.appendingPathComponent("completion.json"))
        isCompleting = true
        completionStarted = ProcessInfo.processInfo.systemUptime
        save()
        if !NSWorkspace.shared.open(url) {
            isCompleting = false
            completionError = "Kunne ikke åpne Raycast. Prøv igjen."
        }
        render()
    }

    func consumeCompletion() {
        if let data = try? Data(contentsOf: directory.appendingPathComponent("completion.json")),
           let result = try? JSONDecoder().decode(FocusCompletionResult.self, from: data),
           result.sessionId == snapshot.session?.id, snapshot.session?.phase != .ended {
            if result.success {
                guard coordinator.end() else { return }
                isCompleting = false
                save()
                hideForSync()
                return
            }
            isCompleting = false
            completionError = result.error
        } else if isCompleting && ProcessInfo.processInfo.systemUptime - completionStarted > 45 {
            isCompleting = false
            completionError = "Venter fortsatt på Raycast. Sjekk Raycast, eller prøv igjen."
        }
    }

    @objc func endSession() {
        guard coordinator.end() else { return }
        hideForSync()
    }

    @objc func suspend() {
        _ = coordinator.pause()
        render()
        save()
    }

    @objc func wake() {
        coordinator.resetClock()
        coordinator.requestSync()
        render()
    }

    func hideForSync() {
        isHiddenForSync = true
        panel.orderOut(nil)
        finishBackgroundIfPossible()
    }

    func finishBackgroundIfPossible() {
        if !isProcessingRequests && isHiddenForSync && !coordinator.needsBackground && coordinator.storageError == nil { NSApp.terminate(nil) }
    }

    @objc func screenChanged() { constrainToScreen() }

    func constrainToScreen() {
        guard let screen = NSScreen.screens.first(where: { $0.visibleFrame.intersects(panel.frame) }) ?? NSScreen.main else { return }
        let area = screen.visibleFrame
        var frame = panel.frame
        frame.size.width = min(frame.width, area.width)
        frame.size.height = min(frame.height, area.height)
        frame.origin.x = max(area.minX, min(frame.origin.x, area.maxX - frame.width))
        frame.origin.y = max(area.minY, min(frame.origin.y, area.maxY - frame.height))
        if panel.frame != frame { panel.setFrame(frame, display: true) }
    }

    func windowDidResize(_ notification: Notification) { layoutTitle() }
    func windowDidEndLiveResize(_ notification: Notification) { save() }
    func windowDidMove(_ notification: Notification) { save() }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard coordinator.pause() else { return false }
        hideForSync()
        return false
    }

    func save() {
        guard let panel = panel else { return }
        snapshot.appearance.width = panel.frame.width
        snapshot.appearance.height = panel.frame.height
        snapshot.appearance.x = panel.frame.origin.x
        snapshot.appearance.y = panel.frame.origin.y
        if coordinator.persist() { lastSave = ProcessInfo.processInfo.systemUptime }
    }

    func applicationWillTerminate(_ notification: Notification) {
        ticker?.invalidate()
        if coordinator != nil {
            coordinator.advance()
            snapshot.session?.pause()
            coordinator.closePeriod()
            save()
        }
        flock(lockDescriptor, LOCK_UN)
        close(lockDescriptor)
    }

}

@main
struct FocusMain {
    static func main() {
        // The preview-only bundle supplies a directory; production is launched by
        // the extension with an explicit support path, never by a global agent.
        guard let path = CommandLine.arguments.count == 2 ? CommandLine.arguments[1]
            : Bundle.main.object(forInfoDictionaryKey: "FocusPreviewDirectory") as? String else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        let descriptor = open(directory.appendingPathComponent("process.lock").path, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0, flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { return }
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let controller = FocusController(directory: directory, lockDescriptor: descriptor)
        application.delegate = controller
        withExtendedLifetime(controller) { application.run() }
    }
}
