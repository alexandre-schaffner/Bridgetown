import Foundation

/// How the daemon is doing from where the app stands: whether it runs, and whether we reach
/// it. The island's trouble dot, the status line, the problem list and the connecting pane
/// each read this one answer rather than piecing it together from the process and the
/// connection.
enum DaemonHealth: Equatable {
    case connected
    /// Launched, or attaching, and not answering yet. `lastError` is why the last try failed.
    case starting(lastError: String?)
    /// It stopped and is about to be launched again, or a restart was asked for.
    case restarting
    /// It has stopped on its own soon after each of its last launches: how the last one ended.
    case keepsExiting(String)
    /// It was reached, then the event stream dropped; the store keeps trying.
    case disconnected(String)
    /// The daemon on our port answered 401: not ours, or the token is wrong.
    case rejected
    /// Exit 98: something else holds the port. `byAnotherDaemon` when that answered 401.
    case portInUse(byAnotherDaemon: Bool)
    /// Nothing to run and not attaching.
    case notBundled

    @MainActor
    init(daemon: DaemonProcess, store: Store) {
        self.init(
            mode: daemon.mode, state: daemon.state, exiting: daemon.keepsExiting ? daemon.lastExit : nil,
            connection: store.connection, lastConnectError: store.lastConnectError
        )
    }

    /// `exiting`: how the last run ended, while the daemon keeps stopping soon after launch.
    init(
        mode: DaemonProcess.Mode, state: DaemonProcess.State, exiting: String? = nil,
        connection: Store.Connection, lastConnectError: String? = nil
    ) {
        if mode == .missing {
            self = .notBundled
            return
        }
        if state == .portInUse {
            self = .portInUse(byAnotherDaemon: connection == .rejected)
            return
        }
        let down = if case .restarting = state { true } else { false }
        switch connection {
        case .connected:
            self = .connected
        case .rejected:
            self = .rejected
        case .connecting, .disconnected:
            // Down, or not reached since its last launch: a daemon that won't stay up.
            if let exiting, down || connection == .connecting {
                self = .keepsExiting(exiting)
            } else if down {
                self = .restarting
            } else if case let .disconnected(reason) = connection {
                self = .disconnected(reason)
            } else {
                self = .starting(lastError: lastConnectError)
            }
        }
    }

    /// Wrong in a way that won't right itself in a moment, so the resting island shows it.
    var isTrouble: Bool {
        switch self {
        case .connected, .starting, .restarting: false
        case .keepsExiting, .disconnected, .rejected, .portInUse, .notBundled: true
        }
    }
}
