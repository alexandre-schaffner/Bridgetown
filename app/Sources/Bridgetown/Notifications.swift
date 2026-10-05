import AppKit
import UserNotifications

/// Posts a user notification for each new "Needs you" action (`NewActions`), and takes it
/// back once the action is gone.
@MainActor
final class Notifier: NSObject {
    /// Set by `start`. UNUserNotificationCenter traps when the process has no bundle
    /// identifier (e.g. under `swift run`), and an e2e run never starts it.
    private var center: UNUserNotificationCenter?
    /// Clicking a notification opens the island.
    var onOpen: (() -> Void)?

    func start() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        self.center = center
        // Posting doesn't wait on the answer: allowed later in System Settings, it works
        // from then on, and until then the system drops what we post.
        Task { _ = try? await center.requestAuthorization(options: [.alert, .sound]) }
    }

    func post(_ actions: [Action]) {
        guard let center else { return }
        for action in actions.prefix(3) {
            let content = UNMutableNotificationContent()
            content.title = action.title
            content.body = action.detail
            content.sound = .default
            content.threadIdentifier = "actions"
            center.add(UNNotificationRequest(identifier: Self.identifier(action.id), content: content, trigger: nil))
        }
    }

    /// Takes back every delivered notification whose action is gone: answered here or in
    /// Slack, or before a relaunch. Clicking one would open the island onto nothing.
    func withdraw(allBut current: Set<String>) {
        guard let center else { return }
        let keep = Set(current.map(Self.identifier))
        Task {
            let stale = await center.deliveredNotifications().map(\.request.identifier).filter { !keep.contains($0) }
            if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
        }
    }

    private static func identifier(_ actionId: String) -> String { "action-\(actionId)" }
}

extension Notifier: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        await MainActor.run { onOpen?() }
    }
}

/// New "Needs you" actions, snapshot to snapshot, diffed on ids. The first snapshot is the
/// baseline, so a relaunch doesn't replay everything already waiting.
struct NewActions {
    /// The last snapshot's ids. Only those: an action id is never used again, so forgetting
    /// the ones that are gone can't announce anything twice.
    private(set) var seen: Set<String>?

    /// The actions not seen before, in "Needs you" order; none during quiet hours.
    mutating func update(_ snap: Snapshot, now: Date = AppClock.now) -> [Action] {
        let ids = Set(snap.actions.map(\.id))
        defer { seen = ids }
        guard let seen, !QuietHours.isActive(snap.settings.quietHours, at: now) else { return [] }
        return snap.sortedActions.filter { !seen.contains($0.id) }
    }
}

enum QuietHours {
    /// `start`/`end` are "HH:mm"; the window may wrap midnight ("22:00"–"08:00").
    static func isActive(_ q: Settings.QuietHours, at date: Date = AppClock.now, calendar: Calendar = .current) -> Bool {
        guard q.enabled, let start = minutes(q.start), let end = minutes(q.end), start != end else { return false }
        let c = calendar.dateComponents([.hour, .minute], from: date)
        let now = (c.hour ?? 0) * 60 + (c.minute ?? 0)
        return start < end ? (now >= start && now < end) : (now >= start || now < end)
    }

    static func minutes(_ hhmm: String) -> Int? {
        let parts = hhmm.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2, (0..<24).contains(parts[0]), (0..<60).contains(parts[1]) else { return nil }
        return parts[0] * 60 + parts[1]
    }
}
