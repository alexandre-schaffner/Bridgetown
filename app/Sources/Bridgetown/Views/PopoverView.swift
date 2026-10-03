import SwiftUI

/// Root of the menu bar window. Swaps between the overview and a pushed session or alert
/// detail (NavigationStack misbehaves inside MenuBarExtra).
struct PopoverView: View {
    @Environment(Store.self) private var store
    @Environment(\.popoverHeight) private var height

    /// A plain swap, no slide: a MenuBarExtra window that hides mid-animation freezes the
    /// transition and leaves both panes half-offset and overlapping.
    var body: some View {
        Group {
            switch store.route {
            case let .session(id):
                if let session = store.snapshot?.session(id: id) {
                    SessionDetailView(session: session)
                } else {
                    OverviewPane()
                }
            case let .alert(id):
                AlertDetailView(alertId: id)
                    .id(id)
            case .overview:
                OverviewPane()
            }
        }
        .frame(width: Metrics.width, height: height, alignment: .top)
        .clipped()
    }
}

private struct OverviewPane: View {
    @Environment(Store.self) private var store
    @ViewState private var showAllRecent = false
    /// The Needs you card shown in full; the others are one row each.
    @ViewState private var expandedAction: String?

    private static let recentLimit = 8

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(spacing: 0) {
                HeaderView(now: context.date)
                Divider()
                PaneScrollView {
                    content(now: context.date)
                        .padding(Metrics.inset)
                }
                Divider()
                FooterView()
            }
        }
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        if let snap = store.snapshot {
            let running = snap.activeSessions
            VStack(alignment: .leading, spacing: 16) {
                TelemetryPanel(snapshot: snap, now: now)
                if snap.actions.isEmpty && running.isEmpty && snap.alerts.isEmpty {
                    EmptyState(channelCount: snap.settings.channels.filter(\.enabled).count, paused: snap.status.paused)
                }
                if !snap.actions.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionHeader(title: "Needs you", count: snap.actions.count, tint: .orange)
                        VStack(spacing: 2) {
                            ForEach(snap.sortedActions) { action in
                                ActionCard(action: action, expanded: expandedAction == action.id) {
                                    withAnimation(.snappy(duration: 0.2)) {
                                        expandedAction = expandedAction == action.id ? nil : action.id
                                    }
                                }
                            }
                        }
                        .padding(4)
                        .panel()
                    }
                }
                if !running.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionHeader(
                            title: "Agents",
                            count: running.count,
                            tint: .accentColor,
                            trailing: Session.breakdown(running)
                        )
                        VStack(spacing: 0) {
                            ForEach(running) { JobRow(session: $0, now: now) }
                        }
                        .padding(4)
                        .panel()
                    }
                }
                if !snap.alerts.isEmpty {
                    recent(snap, now: now)
                }
            }
        } else {
            ConnectingState()
        }
    }

    private func recent(_ snap: Snapshot, now: Date) -> some View {
        let shown = showAllRecent ? snap.alerts : Array(snap.alerts.prefix(Self.recentLimit))
        let hidden = snap.alerts.count - shown.count
        return VStack(alignment: .leading, spacing: 6) {
            SectionHeader(title: "Recent")
            VStack(spacing: 0) {
                ForEach(shown) { alert in
                    AlertRow(alert: alert, session: snap.session(id: alert.sessionId), now: now)
                }
            }
            .padding(4)
            .panel()
            if hidden > 0 || showAllRecent {
                Button(showAllRecent ? "Show less" : "Show \(hidden) more") {
                    withAnimation(.snappy(duration: 0.2)) { showAllRecent.toggle() }
                }
                .buttonStyle(.plain)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
                .padding(.top, 2)
            }
        }
    }
}

private struct EmptyState: View {
    let channelCount: Int
    let paused: Bool

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "bolt.shield")
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(.tertiary)
                .padding(.bottom, 4)
            Text("Nothing has fired yet")
                .font(.system(size: 13, weight: .medium))
            Text(paused
                ? "Paused. Alerts are still triaged, but no agent starts on its own."
                : "Watching \(channelCount) channel\(channelCount == 1 ? "" : "s"). Alerts land here as they're triaged; anything that needs you shows up on top.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.vertical, 28)
    }
}

/// Before the first snapshot: progress while the daemon starts, or why it can't.
private struct ConnectingState: View {
    @Environment(Store.self) private var store
    @Environment(DaemonProcess.self) private var daemon

    /// A reason the wait won't end on its own. The header carries the details and the fix.
    private var blocker: String? {
        if daemon.state == .missing { return "The daemon isn't bundled with this build." }
        if daemon.state == .portInUse { return "The daemon couldn't start: port \(daemon.endpoint.port) is in use." }
        if store.connection == .rejected { return "The daemon on port \(daemon.endpoint.port) won't accept this app." }
        return nil
    }

    var body: some View {
        VStack(spacing: 8) {
            if let blocker {
                Image(systemName: "exclamationmark.shield")
                    .font(.system(size: 24, weight: .light))
                    .foregroundStyle(.secondary)
                Text(blocker)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ProgressView().controlSize(.small)
                Text(daemon.mode == .attach ? "Attaching to daemon on port \(daemon.endpoint.port)…" : "Starting daemon…")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.vertical, 32)
    }
}

private struct FooterView: View {
    var body: some View {
        HStack {
            Button("Open logs") { SystemActions.openLogs() }
            Spacer()
            Button("Quit Bridgetown") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
        .buttonStyle(.plain)
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
    }
}
