import Foundation

// All entry points and transport completions run on the main queue. One writer,
// one in-flight HTTP operation, and a persisted intent before every remote write.
final class FocusCoordinator {
    var snapshot: FocusSnapshot
    let client: TogglClient
    let now: () -> Double
    let uptime: () -> Double
    let write: (FocusSnapshot) throws -> Void
    var onChange: (() -> Void)?
    private(set) var storageError: String?
    private(set) var busy = false
    private(set) var nextRetry: Double?
    private var verifyIDs = Set<String>()
    private var previousUptime: Double
    private var previousWall: Double

    init(snapshot: FocusSnapshot, client: TogglClient = TogglClient(),
         now: @escaping () -> Double = { Date().timeIntervalSince1970 },
         uptime: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime },
         write: @escaping (FocusSnapshot) throws -> Void) {
        self.snapshot = snapshot
        self.client = client
        self.now = now
        self.uptime = uptime
        self.write = write
        previousUptime = uptime()
        previousWall = now()
    }

    var trackingEnabled: Bool { snapshot.session?.togglEnabled ?? snapshot.tracking.settings.enabled }
    var openIndex: Int? { snapshot.tracking.periods.lastIndex { $0.stop == nil } }
    var needsBackground: Bool { busy || snapshot.tracking.takeover?.issue == nil && snapshot.tracking.takeover != nil || snapshot.tracking.periods.contains { $0.hasAutomaticWork } }
    var reviewPeriods: [WorkPeriod] {
        snapshot.tracking.periods.filter { $0.sync == .review || $0.recoveryDetectedAt != nil }
    }
    var pendingStop: Bool {
        snapshot.tracking.takeover != nil || snapshot.tracking.periods.contains {
            $0.stop != nil && ($0.remote?.isRunning == true || [.creating, .uncertain].contains($0.sync)) &&
            ![.synced, .accepted, .local].contains($0.sync)
        }
    }
    var status: String {
        if let error = storageError { return error }
        let suffix = pendingStop ? " Stopp er ikke bekreftet; en Toggl-timer kan fortsatt gå." : ""
        if !reviewPeriods.isEmpty || snapshot.tracking.takeover?.issue != nil {
            return "Trenger handling. " + (reviewPeriods.first?.issue ?? snapshot.tracking.takeover?.issue ?? "Kontroller tiden etter avbruddet.") + suffix
        }
        if let message = snapshot.tracking.message { return message + suffix }
        if snapshot.tracking.periods.contains(where: { $0.hasAutomaticWork }) {
            return "Lagret lokalt – venter på synkronisering." + suffix
        }
        if let index = openIndex, snapshot.tracking.periods[index].sync == .running {
            return "Registrerer i Toggl"
        }
        return trackingEnabled ? "På pause" : "Toggl er av"
    }

    @discardableResult func persist() -> Bool {
        snapshot.updatedAt = now()
        do {
            try write(snapshot)
            storageError = nil
            return true
        } catch {
            snapshot.session?.pause()
            closePeriod()
            storageError = "Kunne ikke lagre. Føringen er pauset. Frigjør diskplass og prøv igjen."
            onChange?()
            return false
        }
    }

    func restore() {
        snapshot.session?.restore()
        snapshot.tracking.takeover?.resumeOnSuccess = false
        for index in snapshot.tracking.periods.indices {
            if snapshot.tracking.periods[index].sync == .creating {
                snapshot.tracking.periods[index].sync = .uncertain
                snapshot.tracking.periods[index].creationUncertain = true
            }
            if snapshot.tracking.periods[index].stop == nil {
                snapshot.tracking.periods[index].stop = snapshot.tracking.periods[index].checkpoint
                snapshot.tracking.periods[index].recoveryDetectedAt = now()
                snapshot.tracking.periods[index].issue = "Avbrutt økt: siste lagring er brukt som stopp. Kontroller det usikre tidsrommet."
            }
        }
        resetClock()
    }

    func resetClock() { previousUptime = uptime(); previousWall = now() }

    func advance() {
        let currentUptime = uptime(), currentWall = now()
        let delta = max(0, currentUptime - previousUptime)
        let clockJump = abs((currentWall - previousWall) - delta) > 2
        previousUptime = currentUptime
        previousWall = currentWall
        guard snapshot.session?.phase == .running else { return }
        if clockJump {
            snapshot.session?.pause()
            closePeriod()
            snapshot.tracking.message = "Systemklokken ble endret eller maskinen sov. Økten er pauset."
            _ = persist()
            return
        }
        let before = snapshot.session!.elapsed
        snapshot.session?.advance(by: delta)
        if let index = openIndex {
            snapshot.tracking.periods[index].activeDuration += snapshot.session!.elapsed - before
            snapshot.tracking.periods[index].checkpoint = snapshot.tracking.periods[index].start + snapshot.tracking.periods[index].activeDuration
        }
        if snapshot.session?.phase == .finished {
            closePeriod()
            _ = persist()
        }
    }

    func closePeriod() {
        guard let index = openIndex else { return }
        snapshot.tracking.periods[index].stop = snapshot.tracking.periods[index].checkpoint
        if snapshot.tracking.periods[index].seconds == 0 && snapshot.tracking.periods[index].sync == .pending {
            snapshot.tracking.periods[index].sync = .local
        }
    }

    private func openPeriod() {
        guard let session = snapshot.session, session.phase == .running, openIndex == nil else { return }
        let settings = snapshot.tracking.settings
        let enabled = trackingEnabled && settings.accountID != nil && settings.workspaceID != nil
        let start = now()
        let description = session.task.title + (settings.includeTaskLink ? "\n" + session.task.url : "")
        snapshot.tracking.periods.append(WorkPeriod(sessionID: session.id, task: session.task, start: start,
            checkpoint: start, accountID: settings.accountID, workspaceID: settings.workspaceID,
            organizationID: settings.organizationID, projectID: settings.project(for: session.task),
            description: description, sync: enabled ? .pending : .local))
    }

    @discardableResult func start(task: FocusTask, duration: Double) -> Bool {
        advance()
        if snapshot.session?.task.id == task.id && snapshot.session?.phase != .ended {
            snapshot.session?.task = task
        } else {
            closePeriod()
            snapshot.session = FocusSession(task: task, duration: duration)
            let enabled = snapshot.tracking.settings.enabled
            snapshot.session?.togglEnabled = enabled
            openPeriod()
        }
        resetClock()
        let saved = persist()
        if saved { requestSync() }
        onChange?()
        return saved
    }

    @discardableResult func editSession(split: Bool = false, _ change: (inout FocusSession) -> Void) -> Bool {
        advance()
        guard var session = snapshot.session else { return persist() }
        let id = session.id
        change(&session)
        if split || id != session.id || session.phase != .running { closePeriod() }
        snapshot.session = session
        if storageError == nil { openPeriod() }
        resetClock()
        let saved = persist()
        if saved { requestSync() }
        onChange?()
        return saved
    }

    @discardableResult func pause() -> Bool {
        snapshot.tracking.takeover?.resumeOnSuccess = false
        return editSession { $0.pause() }
    }
    @discardableResult func end() -> Bool {
        snapshot.tracking.takeover?.resumeOnSuccess = false
        return editSession { $0.end() }
    }
    func togglePause() {
        guard storageError == nil || persist() else { return }
        editSession { session in
            switch session.phase {
            case .running: session.pause()
            case .paused: session.resume()
            case .finished, .ended:
                let enabled = session.togglEnabled
                session = FocusSession(task: session.task, duration: session.duration)
                session.togglEnabled = enabled
            }
        }
    }
    func setTracking(_ enabled: Bool) {
        advance(); closePeriod()
        snapshot.tracking.settings.enabled = enabled
        snapshot.session?.togglEnabled = enabled
        openPeriod()
        if persist() { requestSync() }
        onChange?()
    }
    func chooseProject(_ id: Int64?) {
        advance(); closePeriod()
        if let task = snapshot.session?.task, let key = snapshot.tracking.settings.mappingKey(task) {
            snapshot.tracking.settings.projectChoices[key] = id ?? 0
        } else { snapshot.tracking.settings.defaultProjectID = id }
        openPeriod()
        if persist() { requestSync() }
        onChange?()
    }

    func configure(profile: TogglProfile, workspace: TogglWorkspace, project: Int64?, includeLink: Bool, enabled: Bool) {
        advance(); closePeriod()
        snapshot.tracking.settings.accountID = profile.id
        snapshot.tracking.settings.workspaces = profile.workspaces ?? []
        snapshot.tracking.settings.projects = profile.projects ?? []
        snapshot.tracking.settings.cachedAt = now()
        snapshot.tracking.settings.workspaceID = workspace.id
        snapshot.tracking.settings.organizationID = workspace.organization_id
        snapshot.tracking.settings.defaultProjectID = project
        snapshot.tracking.settings.includeTaskLink = includeLink
        snapshot.tracking.settings.enabled = enabled
        snapshot.session?.togglEnabled = enabled
        openPeriod()
        if persist() { requestSync() }
        onChange?()
    }

    func requestSync(verify: Bool = true) {
        if verify {
            for period in snapshot.tracking.periods where period.sessionID == snapshot.session?.id && [.running, .synced].contains(period.sync) {
                verifyIDs.insert(period.id)
            }
        }
        nextRetry = nil
        pump()
    }
    func retryIfDue() {
        if let retry = nextRetry, now() >= retry { nextRetry = nil; pump() }
    }
    private func index(_ id: String) -> Int? { snapshot.tracking.periods.firstIndex { $0.id == id } }
    private func scope(account: Int64, organization: Int64? = nil) -> String {
        organization.map { "org:\(account):\($0)" } ?? "user:\(account)"
    }

    // Reserve quota and persist the intent before allowing URLSession to send.
    private func send<T: Decodable>(_ method: String, path: String, account: Int64, organization: Int64? = nil,
                                   urgent: Bool = false, token: String? = nil, body: [String: Any]? = nil,
                                   beforeSend: (() -> Void)? = nil,
                                   completion: @escaping (Result<T, TogglError>) -> Void) {
        let key = scope(account: account, organization: organization)
        var budget = snapshot.tracking.budgets[key] ?? RequestBudget()
        let earliest = budget.earliest(now: now(), urgent: urgent)
        if earliest > now() {
            nextRetry = earliest
            completion(.failure(.quota(earliest)))
            return
        }
        budget.attempts.append(now())
        snapshot.tracking.budgets[key] = budget
        beforeSend?()
        guard persist() else { busy = false; completion(.failure(.storage)); return }
        busy = true
        client.request(method, path: path, account: account, token: token, body: body) { (result: Result<T, TogglError>) in
            self.busy = false
            var budget = self.snapshot.tracking.budgets[key] ?? RequestBudget()
            switch result {
            case .success:
                budget.failures = 0
                budget.blockedUntil = 0
            case .failure(let error):
                budget.failures += 1
                let delay = min(300.0, pow(2.0, Double(min(8, budget.failures))))
                switch error {
                case .http(402, let retry): budget.blockedUntil = self.now() + max(3600, retry ?? 0)
                case .http(429, let retry): budget.blockedUntil = self.now() + max(delay, retry ?? 60)
                default: if !error.needsAction { budget.blockedUntil = self.now() + delay }
                }
            }
            self.snapshot.tracking.budgets[key] = budget
            completion(result)
        }
    }

    private func pump() {
        guard !busy, storageError == nil else { return }
        if let takeover = snapshot.tracking.takeover, takeover.issue == nil { performTakeover(takeover); return }
        let periods = snapshot.tracking.periods
        let target = periods.first { [.uncertain, .creating].contains($0.sync) }
            ?? periods.first { $0.remote != nil && $0.stop != nil && [.running, .updating, .pending].contains($0.sync) }
            ?? periods.first { $0.sync == .pending }
            ?? periods.first { verifyIDs.contains($0.id) && [.running, .synced].contains($0.sync) }
        guard let period = target, let account = period.accountID, period.workspaceID != nil else {
            snapshot.tracking.message = nil
            onChange?()
            return
        }
        if [.uncertain, .creating].contains(period.sync) { reconcile(period, account: account); return }
        if period.remote != nil { verify(period, account: account); return }
        if period.stop != nil { create(period, account: account); return }
        send("GET", path: "/me/time_entries/current", account: account) { (result: Result<TogglEntry?, TogglError>) in
            guard let index = self.index(period.id) else { return }
            guard self.snapshot.tracking.periods[index].sync == .pending else { self.finish(); return }
            switch result {
            case .success(let current):
                if let current = current {
                    // Never silently take ownership of a timer started elsewhere.
                    self.snapshot.tracking.periods[index].externalVersion = current
                    self.snapshot.tracking.periods[index].foreignTimer = true
                    self.markReview(period.id, "En annen Toggl-timer går allerede. Velg bytte eller fortsett uten Toggl.")
                } else { self.create(self.snapshot.tracking.periods[index], account: account) }
            case .failure(let error): self.failed(period.id, error: error)
            }
        }
    }

    private func create(_ original: WorkPeriod, account: Int64) {
        guard let index = index(original.id) else { return }
        let period = snapshot.tracking.periods[index]
        guard period.sync == .pending else { pump(); return }
        send("POST", path: "/workspaces/\(period.workspaceID!)/time_entries", account: account,
             organization: period.organizationID ?? period.workspaceID, body: period.payload,
             beforeSend: { self.snapshot.tracking.periods[index].sync = .creating; self.snapshot.tracking.periods[index].creationUncertain = true }) { (result: Result<TogglEntry, TogglError>) in
            guard let index = self.index(period.id) else { return }
            switch result {
            case .success(let entry):
                self.snapshot.tracking.periods[index].remote = entry
                self.snapshot.tracking.periods[index].creationUncertain = false
                self.snapshot.tracking.periods[index].sync = entry.isRunning ? .running : .synced
                self.snapshot.tracking.periods[index].issue = nil
                self.snapshot.tracking.message = nil
                if !period.agreesWithLocal(entry) {
                    self.snapshot.tracking.periods[index].externalVersion = entry
                    self.markReview(period.id, "Toggl returnerte andre tider eller et annet prosjekt. Kontroller registreringen.")
                } else { self.finish() }
            case .failure(let error):
                self.snapshot.tracking.periods[index].sync = error.uncertainWrite ? .uncertain : .pending
                self.snapshot.tracking.periods[index].creationUncertain = error.uncertainWrite
                self.failed(period.id, error: error)
            }
        }
    }

    private func verify(_ period: WorkPeriod, account: Int64) {
        guard let remote = period.remote else { return }
        send("GET", path: "/me/time_entries/\(remote.id)", account: account, urgent: period.stop != nil) { (result: Result<TogglEntry, TogglError>) in
            guard let index = self.index(period.id) else { return }
            switch result {
            case .success(let entry):
                self.verifyIDs.remove(period.id)
                let latest = self.snapshot.tracking.periods[index]
                if latest.stop != nil && latest.agreesWithLocal(entry) {
                    self.snapshot.tracking.periods[index].remote = entry
                    self.snapshot.tracking.periods[index].sync = .synced
                    self.finish()
                } else if !remote.matches(entry) {
                    self.snapshot.tracking.periods[index].externalVersion = entry
                    self.markReview(period.id, "Registreringen ble endret i Toggl. Velg hvilken versjon som skal beholdes.")
                } else if latest.stop != nil { self.update(latest, account: account) }
                else { self.finish() }
            case .failure(let error): self.failed(period.id, error: error)
            }
        }
    }

    private func update(_ period: WorkPeriod, account: Int64) {
        guard let remote = period.remote, let index = index(period.id) else { return }
        send("PUT", path: "/workspaces/\(remote.workspace_id)/time_entries/\(remote.id)", account: account,
             organization: period.organizationID ?? period.workspaceID, urgent: true, body: period.payload,
             beforeSend: { self.snapshot.tracking.periods[index].sync = .updating }) { (result: Result<TogglEntry, TogglError>) in
            guard let index = self.index(period.id) else { return }
            switch result {
            case .success(let entry):
                if !period.agreesWithLocal(entry) {
                    self.snapshot.tracking.periods[index].externalVersion = entry
                    self.markReview(period.id, "Toggl bekreftet andre tider enn de lagrede. Kontroller registreringen.")
                } else {
                    self.snapshot.tracking.periods[index].remote = entry
                    self.snapshot.tracking.periods[index].sync = .synced
                    self.snapshot.tracking.periods[index].issue = nil
                    self.snapshot.tracking.message = nil
                    self.finish()
                }
            case .failure(let error): self.failed(period.id, error: error)
            }
        }
    }

    private func reconcile(_ period: WorkPeriod, account: Int64) {
        let start = TogglDate.string(period.start - 86400), end = TogglDate.string((period.stop ?? now()) + 86400)
        send("GET", path: "/me/time_entries?start_date=\(start)&end_date=\(end)", account: account, urgent: true) { (result: Result<[TogglEntry], TogglError>) in
            guard let index = self.index(period.id) else { return }
            switch result {
            case .success(let entries):
                self.snapshot.tracking.periods[index].candidates = entries.filter {
                    $0.workspace_id == period.workspaceID &&
                    abs((TogglDate.parse($0.start) ?? 0) - period.wireStart) < 2
                }
                self.markReview(period.id, "Opprettelsen er uavklart. Kontroller Toggl før du knytter til en registrering eller oppretter på nytt.")
            case .failure(let error): self.failed(period.id, error: error)
            }
        }
    }

    private func failed(_ id: String, error: TogglError) {
        snapshot.tracking.message = error.message
        if error.needsAction { markReview(id, error.message); return }
        nextRetry = snapshot.tracking.budgets.values.map(\.blockedUntil).filter { $0 > now() }.min() ?? now() + 5
        if case .quota(let until) = error { nextRetry = until }
        _ = persist()
        onChange?()
    }
    private func finish() {
        guard persist() else { return }
        onChange?()
        pump()
    }
    private func markReview(_ id: String, _ message: String) {
        advance()
        snapshot.session?.pause()
        closePeriod()
        if let index = index(id) {
            snapshot.tracking.periods[index].sync = .review
            snapshot.tracking.periods[index].issue = message
        }
        verifyIDs.remove(id)
        if persist() { onChange?(); pump() }
    }

    // Explicit review decisions never create a second entry without user intent.
    func keepExternal(_ id: String) {
        guard let index = index(id) else { return }
        snapshot.tracking.periods[index].sync = .accepted
        snapshot.tracking.periods[index].issue = nil
        snapshot.tracking.periods[index].recoveryDetectedAt = nil
        snapshot.tracking.message = nil
        verifyIDs.remove(id)
        finish()
    }
    func useLocal(_ id: String, candidate: TogglEntry? = nil, recreate: Bool = false) {
        guard let index = index(id) else { return }
        let period = snapshot.tracking.periods[index]
        guard !period.foreignTimer else { return }
        if let selected = candidate ?? period.externalVersion {
            snapshot.tracking.periods[index].remote = selected
        } else if recreate { snapshot.tracking.periods[index].remote = nil }
        snapshot.tracking.periods[index].sync = snapshot.tracking.periods[index].remote == nil ? .pending : .updating
        snapshot.tracking.periods[index].issue = nil
        snapshot.tracking.periods[index].externalVersion = nil
        snapshot.tracking.periods[index].creationUncertain = false
        snapshot.tracking.message = nil
        finish()
    }
    func changeReviewProject(_ id: String, project: Int64?) {
        guard let index = index(id), snapshot.tracking.periods[index].sync == .review,
              snapshot.tracking.periods[index].accountID == snapshot.tracking.settings.accountID,
              snapshot.tracking.periods[index].workspaceID == snapshot.tracking.settings.workspaceID else { return }
        snapshot.tracking.periods[index].projectID = project
    }
    func continueWithoutToggl(_ id: String) {
        guard let index = index(id), snapshot.tracking.periods[index].foreignTimer else { return }
        snapshot.tracking.periods[index].sync = .local
        snapshot.tracking.periods[index].issue = nil
        snapshot.session?.togglEnabled = false
        snapshot.tracking.message = nil
        editSession { $0.resume() }
    }
    func takeOver(_ id: String) {
        guard let index = index(id), let entry = snapshot.tracking.periods[index].externalVersion,
              let account = snapshot.tracking.periods[index].accountID else { return }
        snapshot.tracking.takeover = TogglTakeover(accountID: account,
            organizationID: snapshot.tracking.settings.workspaces.first(where: { $0.id == entry.workspace_id })?.organization_id,
            entry: entry, stopAt: now(), periodID: id)
        finish()
    }
    private func performTakeover(_ takeover: TogglTakeover) {
        send("GET", path: "/me/time_entries/\(takeover.entry.id)", account: takeover.accountID, urgent: true) { (result: Result<TogglEntry, TogglError>) in
            switch result {
            case .success(let entry):
                let start = TogglDate.parse(takeover.entry.start) ?? takeover.stopAt
                let seconds = max(0, Int(floor(takeover.stopAt) - floor(start)))
                let targetStop = TogglDate.string(floor(start) + Double(seconds))
                if entry.stop.flatMap(TogglDate.parse) == TogglDate.parse(targetStop) && entry.duration == seconds { self.finishTakeover(takeover); return }
                guard entry.matches(takeover.entry) else {
                    self.snapshot.tracking.takeover = nil
                    if let index = self.index(takeover.periodID) { self.snapshot.tracking.periods[index].externalVersion = entry }
                    self.markReview(takeover.periodID, "Den andre timeren ble endret. Kontroller den før et nytt bytte.")
                    return
                }
                let body: [String: Any] = ["stop": targetStop, "duration": seconds]
                self.send("PUT", path: "/workspaces/\(entry.workspace_id)/time_entries/\(entry.id)", account: takeover.accountID,
                          organization: takeover.organizationID ?? entry.workspace_id, urgent: true, body: body) { (result: Result<TogglEntry, TogglError>) in
                    switch result {
                    case .success(let stopped):
                        if stopped.stop.flatMap(TogglDate.parse) == TogglDate.parse(targetStop) && stopped.duration == seconds { self.finishTakeover(takeover) }
                        else { self.takeoverFailed(takeover, .invalidResponse) }
                    case .failure(let error): self.takeoverFailed(takeover, error)
                    }
                }
            case .failure(let error): self.takeoverFailed(takeover, error)
            }
        }
    }
    private func takeoverFailed(_ takeover: TogglTakeover, _ error: TogglError) {
        if error.needsAction { snapshot.tracking.takeover?.issue = error.message }
        failed(takeover.periodID, error: error)
    }
    private func finishTakeover(_ completed: TogglTakeover) {
        let takeover = snapshot.tracking.takeover ?? completed
        snapshot.tracking.takeover = nil
        if let index = index(takeover.periodID) {
            snapshot.tracking.periods[index].sync = .local
            snapshot.tracking.periods[index].issue = nil
            if takeover.resumeOnSuccess && snapshot.session?.phase == .paused &&
                snapshot.session?.id == snapshot.tracking.periods[index].sessionID {
                snapshot.session?.togglEnabled = true
                snapshot.session?.resume()
                resetClock(); openPeriod()
            }
        }
        snapshot.tracking.message = nil
        finish()
    }

    func correctRecovery(_ id: String, stop: Double?) {
        guard let index = index(id), let recovered = snapshot.tracking.periods[index].recoveryDetectedAt else { return }
        if let stop = stop {
            let start = snapshot.tracking.periods[index].start
            let nextStart = snapshot.tracking.periods.filter { $0.start > start }.map(\.start).min() ?? recovered
            guard stop >= start, stop <= min(recovered, nextStart) else { return }
            let duration = stop - start
            let delta = duration - snapshot.tracking.periods[index].activeDuration
            snapshot.tracking.periods[index].activeDuration = duration
            snapshot.tracking.periods[index].checkpoint = stop
            snapshot.tracking.periods[index].stop = stop
            if snapshot.session?.id == snapshot.tracking.periods[index].sessionID { snapshot.session?.elapsed += delta }
            if snapshot.tracking.periods[index].sync == .synced { snapshot.tracking.periods[index].sync = .updating }
        }
        snapshot.tracking.periods[index].recoveryDetectedAt = nil
        if snapshot.tracking.periods[index].sync != .review { snapshot.tracking.periods[index].issue = nil }
        finish()
    }

    func connect(token: String?, refresh: Bool = false, completion: @escaping (Result<TogglProfile, TogglError>) -> Void) {
        guard !busy else { completion(.failure(.network(false))); return }
        let account = snapshot.tracking.settings.accountID ?? 0
        send("GET", path: "/me?with_related_data=true", account: account, token: token) { (result: Result<TogglProfile, TogglError>) in
            switch result {
            case .success(let profile):
                do {
                    if let token = token { try self.client.credentials.save(token: token, accountID: profile.id) }
                    if profile.id == self.snapshot.tracking.settings.accountID {
                        self.snapshot.tracking.settings.workspaces = profile.workspaces ?? []
                        self.snapshot.tracking.settings.projects = profile.projects ?? []
                        self.snapshot.tracking.settings.cachedAt = self.now()
                    }
                    // Move the connection request's budget to the validated account.
                    if account != profile.id, let budget = self.snapshot.tracking.budgets.removeValue(forKey: self.scope(account: account)) {
                        let key = self.scope(account: profile.id)
                        var existing = self.snapshot.tracking.budgets[key] ?? RequestBudget()
                        existing.attempts += budget.attempts
                        self.snapshot.tracking.budgets[key] = existing
                    }
                    guard self.persist() else { completion(.failure(.invalidResponse)); return }
                    completion(.success(profile))
                } catch { completion(.failure(.credentials)) }
            case .failure(let error):
                _ = self.persist()
                completion(.failure(error))
            }
            self.onChange?()
            self.pump()
        }
    }
}
