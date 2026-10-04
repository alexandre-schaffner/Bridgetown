import AppKit
import UserNotifications

/// Posts a user notification for each new "Needs you" action (`NewActions`).
///
/// UNUserNotificationCenter traps when the process has no bundle identifier (e.g. under
/// `swift run`), so everything is gated on `isAvailable`.
@MainActor
final class Notifier: NSObject {
    static var isAvailable: Bool { Bundle.main.bundleIdentifier != nil }

    private var authorized = false
    /// Clicking a notification shows the app: the island, or the menu bar window with it off.
    var onOpen: (() -> Void)?

    func start() {
        guard Self.isAvailable else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        Task {
            authorized = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        }
    }

    func post(_ actions: [Action]) {
        guard Self.isAvailable, authorized else { return }
        for action in actions.prefix(3) { post(action) }
    }

    private func post(_ action: Action) {
        let content = UNMutableNotificationContent()
        content.title = action.title
        content.body = action.detail
        content.sound = .default
        content.threadIdentifier = "actions"
        content.userInfo = ["actionId": action.id, "sessionId": action.sessionId ?? ""]
        let request = UNNotificationRequest(identifier: "action-\(action.id)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
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
    private var seen: Set<String>?

    /// The actions not seen before, in "Needs you" order; none during quiet hours.
    mutating func update(_ snap: Snapshot, now: Date = .now) -> [Action] {
        let ids = Set(snap.actions.map(\.id))
        defer { seen = (seen ?? []).union(ids) }
        guard let seen, !QuietHours.isActive(snap.settings.quietHours, at: now) else { return [] }
        return snap.sortedActions.filter { !seen.contains($0.id) }
    }
}

enum QuietHours {
    /// `start`/`end` are "HH:mm"; the window may wrap midnight ("22:00"–"08:00").
    static func isActive(_ q: Settings.QuietHours, at date: Date = .now, calendar: Calendar = .current) -> Bool {
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

/// Best-effort: MenuBarExtra has no public "open" API, so find the status item's button
/// and click it. Falls back to activating the app.
@MainActor
enum StatusItemOpener {
    static func openPopover() {
        NSApp.activate()
        for window in NSApp.windows where window.className.contains("NSStatusBarWindow") {
            if let button = findButton(in: window.contentView) {
                // Already open? A second click would close it.
                let popoverVisible = NSApp.windows.contains { $0.isVisible && $0.className.contains("MenuBarExtraWindow") }
                if !popoverVisible { button.performClick(nil) }
                return
            }
        }
    }

    private static func findButton(in view: NSView?) -> NSStatusBarButton? {
        guard let view else { return nil }
        if let b = view as? NSStatusBarButton { return b }
        for sub in view.subviews { if let b = findButton(in: sub) { return b } }
        return nil
    }
}
