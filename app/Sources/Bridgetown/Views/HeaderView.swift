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
        let health = DaemonHealth(daemon: daemon, store: store)
        Group {
            if let status = store.snapshot?.status, health == .connected {
                let facts = facts(status)
                ViewThatFits(in: .horizontal) {
                    line(status, facts: facts)
                    line(status, facts: Array(facts.prefix(1)))
                    line(status, facts: [])
                }
            } else {
                Text(Self.connectionLine(health, showingLast: store.snapshot != nil))
                    .foregroundStyle(.secondary)
            }
        }
        .font(Typo.caption)
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
        if let sessions = store.snapshot?.metrics.sessions, sessions.started > 0 {
            parts.append("\(sessions.resolved) of \(sessions.started) resolved in 24h")
        }
        return parts
    }

    /// What the connection is doing, in a few words; the problem line below says why. With
    /// the last snapshot still on screen, it says that what shows is no longer live.
    nonisolated static func connectionLine(_ health: DaemonHealth, showingLast: Bool) -> String {
        let state = switch health {
        case .notBundled: "Daemon not installed"
        case .portInUse: "Daemon couldn't start"
        case .keepsExiting: "Daemon keeps stopping"
        case .restarting: "Restarting daemon…"
        case .rejected: "Not connected"
        // The store keeps retrying.
        case .disconnected: "Reconnecting…"
        case .starting, .connected: "Connecting…"
        }
        return showingLast ? "\(state) · showing the last update" : state
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
        SystemActions.openLogs(daemon.log)
    }
}

/// Everything wrong right now, one line each with its fix. Nothing when all is well.
struct ProblemList: View {
    @Environment(Store.self) private var store
    @Environment(DaemonProcess.self) private var daemon
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        let problems = Problem.list(
            health: DaemonHealth(daemon: daemon, store: store),
            attached: daemon.mode == .attach,
            port: daemon.endpoint.port,
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
        case .openLogs?: SystemActions.openLogs(daemon.log)
        case nil: break
        }
    }
}

private struct ProblemLine: View {
    let problem: Problem
    let onFix: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: problem.severity.symbol)
                .font(Typo.small)
                .foregroundStyle(problem.severity.color)
            Text(problem.text)
                .font(Typo.body)
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
