import SwiftUI

// The overview's parts, shared by its two layouts: one column in the preview window
// (`PopoverView`), side by side in the open island (`IslandOpenView`).

extension Snapshot {
    /// Nothing waiting, running or received yet: the overview shows `EmptyState` instead.
    var isQuiet: Bool { actions.isEmpty && activeSessions.isEmpty && alerts.isEmpty }

    var watchedChannelCount: Int { settings.channels.filter(\.enabled).count }

    /// Active sessions with no card in "Needs you": a card already stands for the rest.
    var inFlightSessions: [Session] {
        let carded = Set(actions.compactMap(\.sessionId))
        return activeSessions.filter { !carded.contains($0.id) }
    }

    /// Alerts that aren't on screen already, as a card or as an active session.
    var settledAlerts: [AlertView] {
        let carded = Set(actions.compactMap(\.alertId))
        let active = Set(activeSessions.map(\.id))
        return alerts.filter { alert in
            !carded.contains(alert.id) && !(alert.sessionId.map(active.contains) ?? false)
        }
    }
}

extension AlertOutcome.Kind {
    /// Triage set it aside without asking anyone: kept for calibration, folded by default.
    var isTriagedOut: Bool { self == .filtered || self == .ignored }
}

// MARK: Sections

/// The "Needs you" cards: one row each, the one you open shown in full.
struct NeedsYouSection: View {
    let snapshot: Snapshot
    let now: Date
    @ViewState private var expandedAction: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Needs you", count: snapshot.actions.count)
            RowList(data: snapshot.sortedActions) { action in
                ActionCard(action: action, expanded: expandedAction == action.id, now: now) {
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
            SectionHeader(title: "Agents", count: running.count)
            RowList(data: running) { JobRow(session: $0, now: now) }
        }
    }
}

/// Alerts that have settled: finished sessions, teammates' claims, dismissed cards. What
/// triage filtered or ignored folds into one line, there to check Jev's calls.
struct RecentSection: View {
    let snapshot: Snapshot
    let now: Date
    @ViewState private var showAll = false
    @ViewState private var showTriagedOut = false

    private static let limit = 6

    var body: some View {
        let settled = snapshot.settledAlerts
        let kept = settled.filter { !$0.outcome.kind.isTriagedOut }
        let triagedOut = settled.filter(\.outcome.kind.isTriagedOut)
        let shown = (showAll ? kept : Array(kept.prefix(Self.limit))) + (showTriagedOut ? triagedOut : [])
        let hidden = kept.count - min(kept.count, showAll ? kept.count : Self.limit)
        if !settled.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Recent")
                if !shown.isEmpty {
                    RowList(data: shown) { alert in
                        AlertRow(alert: alert, session: snapshot.session(id: alert.sessionId), now: now)
                    }
                }
                HStack(spacing: 12) {
                    if hidden > 0 || showAll {
                        toggle(showAll ? "Show less" : "Show \(hidden) more", $showAll)
                    }
                    if !triagedOut.isEmpty {
                        toggle(showTriagedOut ? "Hide filtered" : "\(triagedOut.count) filtered out", $showTriagedOut)
                            .help("Alerts a rule or Jev set aside. Open one to say whether that was the right call.")
                    }
                    Spacer(minLength: 0)
                }
                .padding(.leading, 2)
            }
        }
    }

    private func toggle(_ title: String, _ flag: Binding<Bool>) -> some View {
        Button(title) {
            withAnimation(.snappy(duration: 0.2)) { flag.wrappedValue.toggle() }
        }
        .buttonStyle(.plain)
        .font(.geist(11))
        .foregroundStyle(.secondary)
        .hoverHighlight(radius: 4)
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
