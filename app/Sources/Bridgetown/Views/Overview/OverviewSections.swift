import SwiftUI

// The overview's parts, shared by its two layouts: one column in the menu bar window
// (`PopoverView`), side by side in the open island (`IslandOpenView`).

extension Snapshot {
    /// Nothing waiting, running or received yet: the overview shows `EmptyState` instead.
    var isQuiet: Bool { actions.isEmpty && activeSessions.isEmpty && alerts.isEmpty }

    var watchedChannelCount: Int { settings.channels.filter(\.enabled).count }
}

// MARK: Sections

/// The "Needs you" cards: one row each, the one you open shown in full.
struct NeedsYouSection: View {
    let snapshot: Snapshot
    @ViewState private var expandedAction: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Needs you", count: snapshot.actions.count, tint: Ink.amber)
            RowList(data: snapshot.sortedActions) { action in
                ActionCard(action: action, expanded: expandedAction == action.id) {
                    Haptics.perform(.alignment, "needsYou.toggle")
                    withAnimation(.snappy(duration: 0.2)) {
                        expandedAction = expandedAction == action.id ? nil : action.id
                    }
                }
            }
        }
    }
}

struct AgentsSection: View {
    let running: [Session]
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(
                title: "Agents",
                count: running.count,
                tint: running.contains { $0.holder?.isMoving == true } ? Ink.blue : nil,
                trailing: Session.breakdown(running)
            )
            RowList(data: running) { JobRow(session: $0, now: now) }
        }
    }
}

struct RecentSection: View {
    let snapshot: Snapshot
    let now: Date
    @ViewState private var showAll = false

    private static let limit = 8

    var body: some View {
        let alerts = snapshot.alerts
        let shown = showAll ? alerts : Array(alerts.prefix(Self.limit))
        let hidden = alerts.count - shown.count
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Recent")
            RowList(data: shown) { alert in
                AlertRow(alert: alert, session: snapshot.session(id: alert.sessionId), now: now)
            }
            if hidden > 0 || showAll {
                Button(showAll ? "Show less" : "Show \(hidden) more") {
                    withAnimation(.snappy(duration: 0.2)) { showAll.toggle() }
                }
                .buttonStyle(.stage(.secondary, compact: true))
                .frame(maxWidth: .infinity)
            }
        }
    }
}

/// Nothing to show yet: what Bridgetown is watching, or that it's paused.
struct EmptyState: View {
    let snapshot: Snapshot

    var body: some View {
        let channelCount = snapshot.watchedChannelCount
        VStack(spacing: 6) {
            ArchShape(joint: 1.5)
                .stroke(.tertiary, style: StrokeStyle(lineWidth: 1, lineJoin: .round))
                .frame(width: 26, height: 26 / ArchMark.aspect)
                .padding(.bottom, 4)
            Text("Nothing has fired yet")
                .font(.geist(14, .semibold))
            Text(snapshot.status.paused
                ? "Paused. Alerts are still triaged, but no agent starts on its own."
                : "Watching \(channelCount) channel\(channelCount == 1 ? "" : "s"). Alerts land here as they're triaged; anything that needs you shows up on top.")
                .font(.geist(11))
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
struct ConnectingState: View {
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
                    .font(.geist(24, .light))
                    .foregroundStyle(.secondary)
                Text(blocker)
                    .font(.geist(12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ProgressView().controlSize(.small)
                Text(daemon.mode == .attach ? "Attaching to daemon on port \(daemon.endpoint.port)…" : "Starting daemon…")
                    .font(.geist(12))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.vertical, 32)
    }
}

struct FooterView: View {
    var body: some View {
        HStack {
            Button("Open logs") { SystemActions.openLogs() }
            Spacer()
            Button("Quit Bridgetown") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
        .buttonStyle(.plain)
        .font(.geist(11))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}
