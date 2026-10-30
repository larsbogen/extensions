import Foundation

// Presentation policy has no timer, persistence or transport side effects.
struct FocusPresentation {
    let session: FocusSession
    let completing: Bool
    var canPause: Bool { !completing && session.queueCompleted != true && session.pendingNextRequestId == nil }
    var canExtend: Bool { canPause && session.duration > 0 }
    var canNext: Bool { !completing && session.task.queue != nil && session.pendingNextRequestId == nil && session.queueFinished != true }
    var canComplete: Bool { !completing && session.pendingNextRequestId == nil && session.phase != .ended && session.completionDeeplink != nil }
    var canEnd: Bool { !completing && session.pendingNextRequestId == nil }
    var pauseTitle: String {
        switch session.phase {
        case .running: return "Pause"
        case .paused: return "Fortsett"
        case .finished, .ended: return "Ny økt"
        }
    }
}

struct FocusNotice {
    var text: String
    var retry: Bool
    var details: Bool

    static func make(coordinator: FocusCoordinator, completing: Bool, completionError: String?) -> FocusNotice {
        var messages: [String] = []
        if completing { messages.append("Fullfører oppgaven i Todoist. Timeren er satt på pause.") }
        else if let error = completionError { messages.append(error) }
        let tracking = coordinator.snapshot.tracking
        let needsDetails = coordinator.storageError != nil || coordinator.pendingStop ||
            !coordinator.reviewPeriods.isEmpty || tracking.takeover?.issue != nil ||
            tracking.message != nil || tracking.periods.contains { $0.hasAutomaticWork }
        if needsDetails {
            messages.append(coordinator.status)
            // Storage errors have priority in the coordinator's normal status;
            // an unconfirmed external stop must still be visible alongside them.
            if coordinator.pendingStop && coordinator.storageError != nil {
                messages.append("Stopp er ikke bekreftet; en Toggl-timer kan fortsatt gå.")
            }
        }
        return FocusNotice(text: messages.joined(separator: "\n"), retry: !completing && completionError != nil,
                           details: needsDetails)
    }
}

struct FocusGeometry {
    static func frame(anchoredTo frame: CGRect, size: CGSize) -> CGRect {
        CGRect(x: frame.maxX - size.width, y: frame.maxY - size.height, width: size.width, height: size.height)
    }
}
