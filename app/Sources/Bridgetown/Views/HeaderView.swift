import SwiftUI

struct HeaderView: View {
    @Environment(Store.self) private var store
    @Environment(DaemonProcess.self) private var daemon
    @Environment(\.openSettings) private var openSettings
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 7) {
                        BrandMark(size: 20)
                        Text("Bridgetown")
                            .font(.geist(15, .semibold))
                            .tracking(-0.4)
                        if store.snapshot?.status.dryRun == true {
                            Text("Dry run")
                                .font(.geist(10, .medium))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .overlay(PixelStroke(radius: Ink.tagRadius, style: Ink.outline))
                                .help("Agents run, but nothing is posted to Slack")
                        }
                    }
                    if let status = store.snapshot?.status, store.connection == .connected {
                        HealthStrip(status: status, now: now)
                    } else {
                        Text(subtitle)
                            .font(.geist(11))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .contentTransition(.numericText())
                    }
                }
                Spacer(minLength: 0)
                if let paused = store.snapshot?.status.paused {
                    IconButton(
                        systemName: paused ? "play.circle" : "pause.circle",
                        help: paused ? "Resume auto-start" : "Pause auto-start",
                        size: 16
                    ) { store.setPaused(!paused) }
                }
                IconButton(systemName: "gearshape", help: "Settings", size: 14, action: showSettings)
            }

            ForEach(problems) { problem in
                ProblemLine(problem: problem) { fix(problem.fix) }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 12)
    }

    private func showSettings() {
        NSApp.activate()
        openSettings()
    }

    private func fix(_ fix: Problem.Fix?) {
        switch fix {
        case .openSettings?: showSettings()
        case .restartDaemon?: daemon.restart()
        case nil: break
        }
    }

    // MARK: Subtitle

    private var subtitle: String {
        guard let snap = store.snapshot else {
            switch daemon.state {
            case .missing: return "Daemon not installed"
            case .portInUse: return "Daemon couldn't start"
            case .restarting: return "Restarting daemon…"
            default: return store.connection == .rejected ? "Not connected" : "Connecting…"
            }
        }
        var parts: [String] = []
        let running = snap.activeSessions.count
        let waiting = snap.actions.count
        if snap.status.paused { parts.append("Paused") }
        if running > 0 { parts.append("\(running) running") }
        if waiting > 0 { parts.append("\(waiting) \(waiting == 1 ? "needs" : "need") you") }
        if running == 0 && waiting == 0 {
            if !snap.status.paused { parts.append("All quiet") }
            if let poll = snap.status.lastPollAt {
                let rel = Format.relative(poll, now: now)
                parts.append(rel == "now" ? "checked just now" : "checked \(rel) ago")
            }
        }
        return parts.joined(separator: " · ")
    }

    // MARK: Problems

    private var problems: [Problem] {
        Problem.list(
            connection: store.connection,
            daemonState: daemon.state,
            daemonMode: daemon.mode,
            port: daemon.endpoint.port,
            lastConnectError: store.lastConnectError,
            flash: store.flash,
            status: store.snapshot?.status
        )
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

/// The daemon's dependencies at a glance: a dot per service, then when Slack was last
/// polled. A healthy service is a quiet gray dot; only trouble gets colour (the problem
/// lines below say what's wrong and how to fix it).
private struct HealthStrip: View {
    let status: Status
    let now: Date

    private struct Service: Identifiable {
        enum Health { case ok, warning, error, unknown }
        let name: String
        let health: Health
        let help: String
        var id: String { name }
    }

    private var services: [Service] {
        [
            Service(
                name: "Slack",
                health: status.slack == .ok ? .ok : status.slack == .error ? .error : status.slack == .missing_token ? .warning : .unknown,
                help: status.slack == .ok ? "Slack: polling" : status.slack == .missing_token ? "Slack: token missing" : "Slack: failing"
            ),
            Service(
                name: "Jev",
                health: status.jev == .ok ? .ok : status.jev == .unknown ? .unknown : .warning,
                help: status.jev == .ok ? "Jev: triaging" : "Jev: unavailable, triage uses rules only"
            ),
            Service(
                name: "GitHub",
                health: status.github == .ok ? .ok : status.github == .blocked ? .warning : .unknown,
                help: status.github == .blocked ? "GitHub Enterprise blocks this network" : status.github == .ok ? "GitHub: reachable" : "GitHub: not checked yet"
            ),
            Service(
                name: "Grafana",
                health: status.grafanaMcp == .up ? .ok : status.grafanaMcp == .down ? .warning : .unknown,
                help: status.grafanaMcp == .up ? "Grafana MCP: up, sessions can read prod logs" : "Grafana MCP: down, sessions can't read prod logs"
            ),
        ]
    }

    var body: some View {
        HStack(spacing: 8) {
            ForEach(services) { service in
                HStack(spacing: 4) {
                    dot(service.health)
                    Text(service.name)
                        .foregroundStyle(service.health == .ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                }
                .help(service.help)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(service.help)
            }
            if let poll = status.lastPollAt {
                let rel = Format.relative(poll, now: now)
                Text(rel == "now" ? "· polled now" : "· polled \(rel) ago")
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
        }
        .font(.geist(10.5, .medium))
        .lineLimit(1)
    }

    @ViewBuilder
    private func dot(_ health: Service.Health) -> some View {
        switch health {
        case .ok: Circle().fill(Ink.faint).frame(width: 5, height: 5)
        case .warning: Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 8)).foregroundStyle(Ink.amber)
        case .error: Image(systemName: "exclamationmark.octagon.fill").font(.system(size: 8)).foregroundStyle(Ink.red)
        case .unknown: Circle().strokeBorder(Color.secondary, lineWidth: 1).frame(width: 5, height: 5)
        }
    }
}

private struct ProblemLine: View {
    let problem: Problem
    let onFix: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: problem.severity == .error ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                .font(.geist(10))
                .foregroundStyle(problem.severity == .error ? Ink.red : Ink.amber)
            Text(problem.text)
                .font(.geist(11))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .help(problem.text)
            Spacer(minLength: 0)
            if let fix = problem.fix {
                Button(fix.label, action: onFix)
                    .buttonStyle(.link)
                    .foregroundStyle(Ink.blue)
                    .font(.geist(11))
            }
        }
    }
}
