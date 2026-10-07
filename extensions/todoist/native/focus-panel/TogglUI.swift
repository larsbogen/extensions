import AppKit

extension FocusController {
    @objc func openTogglSettings() {
        if settingsWindow == nil { settingsWindow = TogglSettingsWindow(coordinator: coordinator) }
        settingsWindow?.show()
    }
    @objc func toggleToggl() { coordinator.setTracking(togglToggle.state == .on) }
    @objc func changeTogglProject() {
        let index = togglProject.indexOfSelectedItem
        let projects = snapshot.tracking.settings.availableProjects
        guard index == 0 || projects.indices.contains(index - 1) else { return }
        coordinator.chooseProject(index == 0 ? nil : projects[index - 1].id)
    }
    @objc func syncToggl() {
        guard coordinator.persist() else { return }
        coordinator.requestSync()
    }
    @objc func reviewToggl() {
        guard !coordinator.busy else { return }
        guard let period = coordinator.reviewPeriods.first else {
            if let takeover = snapshot.tracking.takeover {
                let alert = NSAlert()
                alert.messageText = "Byttet er ikke bekreftet"
                alert.informativeText = takeover.issue ?? "Kontroller Toggl."
                alert.addButton(withTitle: "Prøv igjen")
                alert.addButton(withTitle: "Lukk")
                if alert.runModal() == .alertFirstButtonReturn {
                    snapshot.tracking.takeover?.issue = nil
                    save(); coordinator.requestSync()
                }
            }
            return
        }
        let alert = NSAlert()
        alert.messageText = period.task.title
        alert.informativeText = period.issue ?? "Kontroller registreringen."
        if period.sync != .review, let detected = period.recoveryDetectedAt {
            let picker = NSDatePicker()
            picker.datePickerStyle = .textFieldAndStepper
            picker.datePickerElements = [.yearMonthDay, .hourMinuteSecond]
            picker.dateValue = Date(timeIntervalSince1970: period.stop ?? period.checkpoint)
            picker.minDate = Date(timeIntervalSince1970: period.start)
            let next = snapshot.tracking.periods.filter { $0.start > period.start }.map(\.start).min() ?? detected
            picker.maxDate = Date(timeIntervalSince1970: min(detected, next))
            picker.frame = NSRect(x: 0, y: 0, width: 320, height: 28)
            picker.setAccessibilityLabel("Korrigert stoppetid etter krasj")
            alert.accessoryView = picker
            alert.addButton(withTitle: "Behold siste lagring")
            alert.addButton(withTitle: "Bruk valgt stoppetid")
            alert.addButton(withTitle: "Senere")
            let choice = alert.runModal()
            if choice == .alertFirstButtonReturn { coordinator.correctRecovery(period.id, stop: nil) }
            else if choice == .alertSecondButtonReturn { coordinator.correctRecovery(period.id, stop: picker.dateValue.timeIntervalSince1970) }
        } else if period.foreignTimer {
            if let entry = period.externalVersion { alert.informativeText += "\n\nAktiv timer: \(entry.description ?? "Uten beskrivelse")" }
            alert.addButton(withTitle: "Bytt til fokusoppgaven")
            alert.addButton(withTitle: "Fortsett uten Toggl")
            alert.addButton(withTitle: "Senere")
            let choice = alert.runModal()
            if choice == .alertFirstButtonReturn { coordinator.takeOver(period.id) }
            else if choice == .alertSecondButtonReturn { coordinator.continueWithoutToggl(period.id) }
        } else if period.creationUncertain {
            let picker = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 350, height: 28))
            picker.addItems(withTitles: period.candidates.map { "#\($0.id) · \($0.description ?? "Uten beskrivelse")" })
            picker.setAccessibilityLabel("Mulig Toggl-registrering")
            if !period.candidates.isEmpty { alert.accessoryView = picker }
            alert.addButton(withTitle: period.candidates.isEmpty ? "Kontroller på nytt" : "Knytt til valgt")
            alert.addButton(withTitle: "Jeg har kontrollert: opprett på nytt")
            alert.addButton(withTitle: "Behold bare lokalt")
            alert.addButton(withTitle: "Senere")
            let choice = alert.runModal()
            if choice == .alertFirstButtonReturn {
                if period.candidates.isEmpty {
                    if let index = snapshot.tracking.periods.firstIndex(where: { $0.id == period.id }) {
                        snapshot.tracking.periods[index].sync = .uncertain
                        save(); coordinator.requestSync()
                    }
                } else { coordinator.useLocal(period.id, candidate: period.candidates[picker.indexOfSelectedItem]) }
            } else if choice == .alertSecondButtonReturn {
                let confirm = NSAlert()
                confirm.messageText = "Opprette en ny registrering?"
                confirm.informativeText = "Dette kan gi dobbeltføring dersom den første registreringen allerede finnes i Toggl."
                confirm.addButton(withTitle: "Opprett ny")
                confirm.addButton(withTitle: "Avbryt")
                if confirm.runModal() == .alertFirstButtonReturn { coordinator.useLocal(period.id, recreate: true) }
            } else if choice == .alertThirdButtonReturn { coordinator.keepExternal(period.id) }
        } else if let external = period.externalVersion {
            alert.informativeText += "\n\nLokalt: \(period.seconds) sekunder\nToggl: \(external.isRunning ? "timeren går" : "\(external.duration) sekunder")\nBeskrivelse i Toggl: \(external.description ?? "")"
            alert.addButton(withTitle: "Behold Toggl-versjonen")
            alert.addButton(withTitle: "Erstatt med lokal tid")
            alert.addButton(withTitle: "Senere")
            let choice = alert.runModal()
            if choice == .alertFirstButtonReturn { coordinator.keepExternal(period.id) }
            else if choice == .alertSecondButtonReturn { coordinator.useLocal(period.id) }
        } else {
            let projects = snapshot.tracking.settings.availableProjects
            let canChangeProject = period.accountID == snapshot.tracking.settings.accountID && period.workspaceID == snapshot.tracking.settings.workspaceID
            let picker = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 350, height: 28))
            picker.addItems(withTitles: ["Behold opprinnelig prosjekt", "Uten prosjekt"] + projects.map(\.name))
            picker.setAccessibilityLabel("Prosjekt for den ventende registreringen")
            if canChangeProject { alert.accessoryView = picker }
            alert.addButton(withTitle: "Prøv igjen")
            alert.addButton(withTitle: "Toggl-innstillinger")
            alert.addButton(withTitle: "Behold bare lokalt")
            alert.addButton(withTitle: "Senere")
            let choice = alert.runModal()
            if choice == .alertFirstButtonReturn {
                if canChangeProject && picker.indexOfSelectedItem > 0 {
                    let index = picker.indexOfSelectedItem
                    coordinator.changeReviewProject(period.id, project: index == 1 ? nil : projects[index - 2].id)
                }
                coordinator.useLocal(period.id)
            }
            else if choice == .alertSecondButtonReturn { openTogglSettings() }
            else if choice == .alertThirdButtonReturn { coordinator.keepExternal(period.id) }
        }
        render()
    }
}

final class TogglSettingsWindow: NSObject, NSWindowDelegate {
    let coordinator: FocusCoordinator
    let window: NSWindow
    let token = NSSecureTextField()
    let workspace = NSPopUpButton()
    let project = NSPopUpButton()
    let includeLink = NSButton(checkboxWithTitle: "Ta med Todoist-lenken i beskrivelsen", target: nil, action: nil)
    let enabled = NSButton(checkboxWithTitle: "Registrer nye fokusøkter i Toggl", target: nil, action: nil)
    let connect = NSButton(title: "Koble til", target: nil, action: nil)
    let refresh = NSButton(title: "Oppdater prosjektlisten", target: nil, action: nil)
    let save = NSButton(title: "Lagre", target: nil, action: nil)
    let status = NSTextField(wrappingLabelWithString: "")
    var profile: TogglProfile?
    var loading = false

    init(coordinator: FocusCoordinator) {
        self.coordinator = coordinator
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 470, height: 380),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Toggl Track"
        window.isReleasedWhenClosed = false
        window.delegate = self
        token.placeholderString = "API-token (lagres i macOS-nøkkelringen)"
        token.setAccessibilityLabel("Toggl API-token")
        workspace.setAccessibilityLabel("Toggl-arbeidsområde")
        project.setAccessibilityLabel("Standardprosjekt i Toggl")
        workspace.target = self; workspace.action = #selector(changeWorkspace)
        connect.target = self; connect.action = #selector(connectAccount)
        refresh.target = self; refresh.action = #selector(refreshProjects)
        save.target = self; save.action = #selector(saveSettings)
        save.keyEquivalent = "\r"
        for button in [connect, refresh, save] { button.bezelStyle = .rounded }
        let tokenRow = NSStackView(views: [token, connect])
        token.widthAnchor.constraint(equalToConstant: 315).isActive = true
        let footer = NSStackView(views: [refresh, save])
        let stack = NSStackView(views: [tokenRow, NSTextField(labelWithString: "Arbeidsområde"), workspace,
                                      NSTextField(labelWithString: "Standardprosjekt"), project,
                                      includeLink, enabled, status, footer])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24),
            workspace.widthAnchor.constraint(equalTo: stack.widthAnchor),
            project.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        status.setContentCompressionResistancePriority(.required, for: .vertical)
        window.center()
    }
    func show() {
        guard !loading else { window.makeKeyAndOrderFront(nil); return }
        token.stringValue = ""
        let settings = coordinator.snapshot.tracking.settings
        profile = settings.accountID.map { TogglProfile(id: $0, workspaces: settings.workspaces, projects: settings.projects) }
        includeLink.state = settings.includeTaskLink ? .on : .off
        enabled.state = settings.enabled ? .on : .off
        populate()
        status.stringValue = settings.accountID == nil ? "Lim inn tokenet fra Toggl → Profile → API Token." : "Tokenet er lagret i nøkkelringen. Skriv inn et nytt for å bytte eller koble til igjen."
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if settings.accountID != nil && coordinator.now() - settings.cachedAt > 86400 && !coordinator.busy { refreshProjects() }
    }
    func populate() {
        let settings = coordinator.snapshot.tracking.settings
        workspace.removeAllItems()
        workspace.addItems(withTitles: (profile?.workspaces ?? []).map(\.name))
        if let index = profile?.workspaces?.firstIndex(where: { $0.id == settings.workspaceID }) { workspace.selectItem(at: index) }
        changeWorkspace()
        let projects = availableProjects
        if let index = projects.firstIndex(where: { $0.id == settings.defaultProjectID }) { project.selectItem(at: index + 1) }
        save.isEnabled = !loading && selectedWorkspace != nil
        refresh.isEnabled = !loading && coordinator.snapshot.tracking.settings.accountID != nil
        connect.isEnabled = !loading
        workspace.isEnabled = !loading
        project.isEnabled = !loading
    }
    var selectedWorkspace: TogglWorkspace? {
        guard let workspaces = profile?.workspaces, workspaces.indices.contains(workspace.indexOfSelectedItem) else { return nil }
        return workspaces[workspace.indexOfSelectedItem]
    }
    var availableProjects: [TogglProject] {
        (profile?.projects ?? []).filter { $0.workspaceID == selectedWorkspace?.id && $0.active != false && $0.can_track_time != false }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    @objc func changeWorkspace() {
        project.removeAllItems()
        project.addItems(withTitles: ["Uten prosjekt"] + availableProjects.map(\.name))
    }
    @objc func connectAccount() {
        let secret = token.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !secret.isEmpty else { status.stringValue = "Skriv inn API-tokenet først."; return }
        load(token: secret)
    }
    @objc func refreshProjects() { load(token: nil) }
    func load(token secret: String?) {
        guard !coordinator.busy else { status.stringValue = "En synkronisering pågår. Prøv igjen om et øyeblikk."; return }
        loading = true
        populate()
        status.stringValue = "Henter arbeidsområder og prosjekter …"
        coordinator.connect(token: secret) { result in
            self.loading = false
            switch result {
            case .success(let profile):
                self.profile = profile
                self.token.stringValue = ""
                if secret != nil && profile.id != self.coordinator.snapshot.tracking.settings.accountID {
                    self.enabled.state = .on
                }
                self.status.stringValue = "Tilkoblet. Velg arbeidsområde og standardprosjekt, og trykk Lagre."
            case .failure(let error): self.status.stringValue = error.message
            }
            self.populate()
        }
    }
    @objc func saveSettings() {
        guard let profile = profile, let workspace = selectedWorkspace, !loading else { return }
        let index = project.indexOfSelectedItem
        let projects = availableProjects
        coordinator.configure(profile: profile, workspace: workspace,
                              project: index > 0 && projects.indices.contains(index - 1) ? projects[index - 1].id : nil,
                              includeLink: includeLink.state == .on, enabled: enabled.state == .on)
        if coordinator.storageError == nil { window.close() }
        else { status.stringValue = coordinator.storageError ?? "" }
    }
    func windowWillClose(_ notification: Notification) { token.stringValue = "" }
}
