import AppKit
import UserNotifications

/// Posts a user notification for each new "Needs you" action (`NewActions`), and takes it
/// back once the action is gone. Also says when a newer Bridgetown is out (`Updater`).
@MainActor
final class Notifier: NSObject {
    /// Set by `start`, or by a test. UNUserNotificationCenter traps when the process has no
    /// bundle identifier (e.g. under `swift run`), and an e2e run never starts it.
    private var center: (any NotificationShelf)?
    /// The actions standing at the last snapshot; their notifications stay.
    private var standing: Set<String>?
    /// Clicking a notification opens the island.
    var onOpen: (() -> Void)?

    init(center: (any NotificationShelf)? = nil) {
        self.center = center
    }

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
            center.post(UNNotificationRequest(identifier: Self.identifier(action.id), content: content, trigger: nil))
        }
    }

    /// Once per release, without a sound: it can wait for you.
    func post(update release: Release) {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = "Bridgetown \(release.version) is available"
        content.body = "Open Bridgetown to install it. It relaunches in a few seconds."
        content.threadIdentifier = "update"
        center.post(UNNotificationRequest(identifier: Self.updateIdentifier, content: content, trigger: nil))
    }

    /// At launch: what it said came before this run, perhaps before this version.
    func withdrawUpdate() {
        center?.remove([Self.updateIdentifier])
    }

    /// Takes back every delivered notification whose action is gone: answered here or in
    /// Slack, or before a relaunch. Clicking one would open the island onto nothing.
    /// Nothing to do while the same actions stand.
    func withdraw(allBut current: Set<String>) {
        guard current != standing else { return }
        standing = current
        guard let center else { return }
        Task {
            let delivered = await center.delivered()
            // Kept: the actions standing once the answer is in, not when it was asked. One
            // that came up in between has just been posted, and stays.
            let keep = Set((standing ?? []).map(Self.identifier))
            let stale = delivered.filter { $0 != Self.updateIdentifier && !keep.contains($0) }
            if !stale.isEmpty { center.remove(stale) }
        }
    }

    private static func identifier(_ actionId: String) -> String { "action-\(actionId)" }
    /// One at a time: a newer release replaces the last one's.
    static let updateIdentifier = "update"
}

/// Notification Center as `Notifier` uses it: the system's, or a test's that holds its
/// answers back.
@MainActor
protocol NotificationShelf: AnyObject {
    func post(_ request: UNNotificationRequest)
    /// The identifiers of the notifications still shown.
    func delivered() async -> [String]
    func remove(_ identifiers: [String])
}

extension UNUserNotificationCenter: NotificationShelf {
    func post(_ request: UNNotificationRequest) { add(request) }

    func delivered() async -> [String] {
        await deliveredNotifications().map(\.request.identifier)
    }

    func remove(_ identifiers: [String]) { removeDeliveredNotifications(withIdentifiers: identifiers) }
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
