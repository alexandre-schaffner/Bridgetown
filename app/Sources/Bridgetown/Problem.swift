import SwiftUI

/// Something wrong right now, as one line in the prod column with its fix.
struct Problem: Identifiable, Equatable {
    enum Severity {
        case warning, error

        var symbol: String { self == .error ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill" }
        var color: Color { self == .error ? Ink.red : Ink.amber }
    }
    enum Fix: Equatable {
        case openSettings(String)
        case restartDaemon(String)
        case openLogs(String)

        var label: String {
            switch self {
            case let .openSettings(label), let .restartDaemon(label), let .openLogs(label): label
            }
        }
    }

    let id: String
    let text: String
    let severity: Severity
    var fix: Fix?

    /// Everything wrong right now, worst first: the daemon connection, the last failed
    /// action, then what the daemon reports about its own dependencies.
    static func list(health: DaemonHealth, attached: Bool, port: Int, flash: String?, status: Status?) -> [Problem] {
        var out: [Problem] = []
        switch health {
        case let .portInUse(byAnotherDaemon):
            // Our daemon exited 98. A 401 on that port means the holder is another daemon.
            let text = byAnotherDaemon
                ? "Another Bridgetown daemon is running on port \(port). Quit it, then retry."
                : "Port \(port) is in use by another process. Free it, then retry."
            out.append(.init(id: "daemon", text: text, severity: .error, fix: .restartDaemon("Retry")))
        case .rejected:
            let text = attached
                ? "The daemon on port \(port) rejected the API token. Check BRIDGETOWN_API_TOKEN."
                : "Another Bridgetown daemon is running on port \(port)."
            out.append(.init(id: "daemon", text: text, severity: .error))
        case let .keepsExiting(exit):
            out.append(.init(id: "daemon", text: "The daemon keeps stopping soon after it starts (\(exit))", severity: .error, fix: .openLogs("Open logs")))
        // The reason names the daemon already ("Daemon not reachable").
        case let .disconnected(reason):
            out.append(.init(id: "daemon", text: "Disconnected · \(reason)", severity: .error))
        case .notBundled:
            out.append(.init(id: "daemon", text: "No daemon bundled. Set BRIDGETOWN_DAEMON_CMD or BRIDGETOWN_ATTACH=1.", severity: .error))
        case let .starting(lastError?) where attached:
            out.append(.init(id: "daemon", text: "Attaching · \(lastError)", severity: .warning))
        case .starting, .restarting, .connected:
            break
        }
        if let flash {
            out.append(.init(id: "flash", text: flash, severity: .error))
        }
        guard let status, health == .connected else { return out }
        switch status.slack {
        case .missing_token: out.append(.init(id: "slack", text: "Slack token missing", severity: .warning, fix: .openSettings("Add token")))
        case .error: out.append(.init(id: "slack", text: "Slack is failing", severity: .error))
        default: break
        }
        switch status.jev {
        case .missing_key: out.append(.init(id: "jev", text: "TypeSafe key missing · triage uses rules only", severity: .warning, fix: .openSettings("Add key")))
        case .error: out.append(.init(id: "jev", text: "Jev unavailable · triage uses rules only", severity: .warning))
        default: break
        }
        if status.github == .blocked {
            out.append(.init(id: "github", text: "GitHub Enterprise blocks this network (IP allow list) · sessions wait", severity: .warning))
        }
        if status.grafanaMcp == .down {
            out.append(.init(id: "grafana", text: "Grafana MCP down", severity: .warning))
        }
        if let error = status.error, !error.isEmpty {
            out.append(.init(id: "error", text: error, severity: .error))
        }
        return out
    }
}
