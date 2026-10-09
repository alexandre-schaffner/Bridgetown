import Foundation

/// Alerts swept out of Recent: the user has read how they ended and wants them off the
/// overview. The app keeps this in its defaults (`@AppStorage`); the daemon still has
/// every alert, and the alert's detail still opens from its session.
///
/// An alert is swept as it ended: one that ends again another way (its card dismissed and
/// then investigated anyway, so a session took it) comes back to Recent.
struct RecentSweep: Equatable, RawRepresentable {
    private(set) var keys: Set<String> = []

    init() {}

    /// One key a line: alert ids hold neither a newline nor `|`.
    init?(rawValue: String) {
        keys = Set(rawValue.split(separator: "\n").map(String.init))
    }

    var rawValue: String { keys.sorted().joined(separator: "\n") }

    var isEmpty: Bool { keys.isEmpty }

    func contains(_ alert: AlertView) -> Bool { keys.contains(Self.key(alert)) }

    mutating func sweep(_ alerts: some Sequence<AlertView>) {
        keys.formUnion(alerts.map(Self.key))
    }

    /// Puts swept alerts back (Undo).
    mutating func restore(_ alerts: some Sequence<AlertView>) {
        keys.subtract(alerts.map(Self.key))
    }

    /// Forgets alerts the daemon no longer lists, so the defaults don't grow forever.
    mutating func keep(only alerts: some Sequence<AlertView>) {
        keys.formIntersection(alerts.map(Self.key))
    }

    private static func key(_ alert: AlertView) -> String {
        [alert.id, alert.outcome.kind.rawValue, alert.sessionId ?? ""].joined(separator: "|")
    }
}
