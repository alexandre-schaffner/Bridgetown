import SwiftUI

/// The app's own line, in the band beside the notch: how Bridgetown is doing, in one
/// sentence, and its menu. Healthy services say nothing; whatever is wrong is listed by
/// `ProblemList`.
struct HeaderView: View {
    /// How far the status line may run: up to the wings beside the notch, not under them.
    let room: CGFloat

    var body: some View {
        HStack(spacing: 8) {
            StatusSummary()
                .frame(maxWidth: max(0, room), alignment: .leading)
            Spacer(minLength: 0)
            AppMenu()
        }
    }
}

/// "Polled 2m ago · 1 of 15 resolved in 24h", or what the connection is doing. A pause or a
/// dry run leads, since either changes what the rest means. Short of room, the facts after
/// it drop from the end rather than be cut mid-word.
struct StatusSummary: View {
    @Environment(Store.self) private var store
    @Environment(DaemonProcess.self) private var daemon
    @Environment(\.now) private var now

    var body: some View {
        Group {
            if let status = store.snapshot?.status, store.connection == .connected {
                let facts = facts(status)
                ViewThatFits(in: .horizontal) {
                    line(status, facts: facts)
                    line(status, facts: Array(facts.prefix(1)))
                    line(status, facts: [])
                }
            } else {
                Text(connectionLine)
                    .foregroundStyle(.secondary)
            }
        }
        .font(.geist(11))
        .monospacedDigit()
        .lineLimit(1)
        .contentTransition(.numericText())
    }

    private func line(_ status: Status, facts: [String]) -> some View {
        HStack(spacing: 6) {
            if status.paused {
                Text("Paused")
                    .foregroundStyle(.primary)
                    .help("Alerts are still triaged, but no agent starts on its own")
                TextLink("Resume") { store.setPaused(false) }
                    .accessibilityIdentifier("header.resume")
            }
            if status.dryRun {
                if status.paused { dot }
                Text("Dry run")
                    .foregroundStyle(.primary)
                    .help("Agents run, but nothing is posted to Slack")
            }
            if !facts.isEmpty {
                if status.paused || status.dryRun { dot }
                Text(facts.joined(separator: " · "))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var dot: some View { Text("·").foregroundStyle(.tertiary) }

    /// Most telling first: the first to stay when the line is short of room.
    private func facts(_ status: Status) -> [String] {
        var parts: [String] = []
        if let poll = status.lastPollAt {
            parts.append("Polled \(Format.ago(poll, now: now))")
        }
        if let sessions = store.snapshot?.metrics?.sessions, sessions.started > 0 {
            parts.append("\(sessions.resolved) of \(sessions.started) resolved in 24h")
        }
        return parts
    }

    private var connectionLine: String {
        switch daemon.state {
        case .missing: "Daemon not installed"
        case .portInUse: "Daemon couldn't start"
        case .restarting: "Restarting daemon…"
        default:
            switch store.connection {
            case .rejected: "Not connected"
            // The store keeps retrying; the problem line below says why it dropped.
            case .disconnected: "Reconnecting…"
            case .connecting, .connected: "Connecting…"
            }
        }
    }
}

/// Settings, pause, logs and quit: everything about the app itself, one click away and
/// out of sight. ⌘Q and ⌘, work without opening it.
struct AppMenu: View {
    @Environment(Store.self) private var store
    @Environment(DaemonProcess.self) private var daemon
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Menu {
            items
            Divider()
            Button("Quit Bridgetown") { NSApp.terminate(nil) }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 13, weight: .medium))
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .foregroundStyle(.secondary)
        .hoverFill(radius: 6)
        .fixedSize()
        .help("Settings, logs, quit")
        .accessibilityLabel("Bridgetown menu")
        .accessibilityIdentifier("header.menu")
        // The same items as named actions: VoiceOver and an e2e run reach them without
        // opening the menu.
        .accessibilityActions { items }
        .background {
            // Shortcuts need a button in the hierarchy; these draw nothing.
            Group {
                Button("Settings", action: showSettings).keyboardShortcut(",")
                Button("Quit Bridgetown") { NSApp.terminate(nil) }.keyboardShortcut("q")
            }
            .opacity(0)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private var items: some View {
        Button("Settings…", action: showSettings)
        if let paused = store.snapshot?.status.paused {
            Button(paused ? "Resume auto-start" : "Pause auto-start") { store.setPaused(!paused) }
        }
        Button("Open logs", action: openLogs)
    }

    private func showSettings() {
        SystemActions.showSettings(openSettings)
    }

    private func openLogs() {
        SystemActions.openLogs(daemon.logURL)
    }
}

/// Everything wrong right now, one line each with its fix. Nothing when all is well.
struct ProblemList: View {
    @Environment(Store.self) private var store
    @Environment(DaemonProcess.self) private var daemon
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        let problems = Problem.list(
            connection: store.connection,
            daemonState: daemon.state,
            daemonMode: daemon.mode,
            port: daemon.endpoint.port,
            lastConnectError: store.lastConnectError,
            flash: store.flash,
            status: store.snapshot?.status
        )
        if !problems.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(problems) { problem in
                    ProblemLine(problem: problem) { fix(problem.fix) }
                }
            }
            .padding(.horizontal, Metrics.inset)
        }
    }

    private func fix(_ fix: Problem.Fix?) {
        switch fix {
        case .openSettings?: SystemActions.showSettings(openSettings)
        case .restartDaemon?: daemon.restart()
        case nil: break
        }
    }
}

struct Problem: Identifiable, Equatable {
    enum Severity { case warning, error }
    enum Fix: Equatable {
        case openSettings(String)
        case restartDaemon(String)

        var label: String {
            switch self {
            case let .openSettings(label), let .restartDaemon(label): label
            }
        }
    }

    let id: String
    let text: String
    let severity: Severity
    var fix: Fix?

    /// Everything wrong right now, worst first: the daemon connection, the last failed
    /// action, then what the daemon reports about its own dependencies.
    static func list(
        connection: Store.Connection,
        daemonState: DaemonProcess.State,
        daemonMode: DaemonProcess.Mode,
        port: Int,
        lastConnectError: String?,
        flash: String?,
        status: Status?
    ) -> [Problem] {
        var out: [Problem] = []
        if daemonState == .portInUse {
            // Our daemon exited 98. A 401 on that port means the holder is another daemon.
            let text = connection == .rejected
                ? "Another Bridgetown daemon is running on port \(port). Quit it, then retry."
                : "Port \(port) is in use by another process. Free it, then retry."
            out.append(.init(id: "daemon", text: text, severity: .error, fix: .restartDaemon("Retry")))
        } else {
            switch connection {
            case .rejected:
                let text = daemonMode == .attach
                    ? "The daemon on port \(port) rejected the API token. Check BRIDGETOWN_API_TOKEN."
                    : "Another Bridgetown daemon is running on port \(port)."
                out.append(.init(id: "daemon", text: text, severity: .error))
            case let .disconnected(reason):
                out.append(.init(id: "daemon", text: "Daemon disconnected · \(reason)", severity: .error))
            case .connecting where daemonState == .missing:
                out.append(.init(id: "daemon", text: "No daemon bundled. Set BRIDGETOWN_DAEMON_CMD or BRIDGETOWN_ATTACH=1.", severity: .error))
            case .connecting:
                if let reason = lastConnectError, daemonMode == .attach {
                    out.append(.init(id: "daemon", text: "Waiting for daemon · \(reason)", severity: .warning))
                }
            case .connected:
                break
            }
        }
        if let flash {
            out.append(.init(id: "flash", text: flash, severity: .error))
        }
        guard let status, connection == .connected else { return out }
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

private struct ProblemLine: View {
    let problem: Problem
    let onFix: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: problem.severity == .error ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                .font(.geist(11.5))
                .foregroundStyle(problem.severity == .error ? Ink.red : Ink.amber)
            Text(problem.text)
                .font(.geist(12))
                .lineSpacing(Typo.rowLineSpacing)
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .help(problem.text)
            Spacer(minLength: 0)
            if let fix = problem.fix {
                Button(fix.label, action: onFix)
                    .buttonStyle(.stage(.secondary))
                    .fixedSize()
            }
        }
    }
}
