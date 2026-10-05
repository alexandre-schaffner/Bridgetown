import SwiftUI

// The overview's parts, laid out side by side in the open island (`IslandOpenView`).

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

// MARK: Sections

/// What's waiting on you, as one full-width table under the decision each row asks for (Answer,
/// Ship, Investigate, Retry or close). A row is its subject and its age; its button shows
/// on hover, since the group already names the verb. The one you open shows in full.
struct NeedsYouSection: View {
    @Environment(Store.self) private var store
    let snapshot: Snapshot
    var now: Date = AppClock.now
    @ViewState private var expandedAction: String?
    @ViewState private var selection = RowSelection()
    @ViewState private var confirmingClose = false

    var body: some View {
        let groups = snapshot.actionGroups
        let order = groups.flatMap { $0.actions.map(\.id) }
        VStack(alignment: .leading, spacing: 8) {
            PickingHeader(selection: $selection, order: order) {
                SectionHeader(title: "Needs you", count: snapshot.actions.count)
            } actions: {
                bulkActions
            }
            .padding(.horizontal, Metrics.inset)
            VStack(spacing: 0) {
                ForEach(groups, id: \.group) { entry in
                    Hairline()
                    GroupRow(group: entry.group, count: entry.actions.count, pick: groupPick(entry.actions.map(\.id)))
                    ForEach(entry.actions) { action in
                        Hairline()
                        ActionCard(
                            action: action,
                            expanded: expandedAction == action.id,
                            now: now,
                            pick: $selection.pick(action.id, in: order)
                        ) {
                            Haptics.perform(.alignment, "needsYou.toggle")
                            withAnimation(.snappy(duration: 0.2)) {
                                expandedAction = expandedAction == action.id ? nil : action.id
                            }
                        }
                        .transition(.opacity)
                    }
                }
                Hairline()
            }
            .animation(Easing.state, value: order)
        }
        .onChange(of: selection.isEmpty) { confirmingClose = false }
    }

    private var picked: [Action] {
        snapshot.sortedActions.filter { selection.contains($0.id) && !$0.inFlight }
    }

    /// The shared primary (Investigate 3, Retry 2) when the picked rows have one, and
    /// Dismiss. Dismissing a card that closes its session says so and asks first.
    @ViewBuilder
    private var bulkActions: some View {
        let picked = picked
        let closes = picked.filter(\.dismissCloses).count
        if confirmingClose {
            Text(closes == 1 ? "Close 1 session without a fix?" : "Close \(closes) sessions without a fix?")
                .font(.geist(11))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
            ConfirmButtons(confirmLabel: "Close") {
                confirmingClose = false
                finish { picked.forEach(store.dismiss) }
            } onCancel: {
                confirmingClose = false
            }
        } else {
            Button(closes > 0 ? "Close…" : "Dismiss") {
                if closes > 0 { confirmingClose = true } else { finish { picked.forEach(store.dismiss) } }
            }
            .buttonStyle(.stage(.secondary, compact: true))
            .disabled(picked.isEmpty)
            .help(closes > 0 ? "Some of these close their session without a fix" : "Dismiss the selected cards")
            if let label = picked.sharedPrimary {
                Button("\(label) \(picked.count)") {
                    finish { picked.forEach { store.resolve($0) } }
                }
                .buttonStyle(.stage(.primary, compact: true))
            }
        }
    }

    private func finish(_ act: () -> Void) {
        act()
        Haptics.perform(.alignment, "needsYou.bulk")
        selection.clear()
    }

    /// A group's header picks or unpicks the whole group.
    private func groupPick(_ ids: [String]) -> RowPick {
        RowPick(
            selected: ids.allSatisfy(selection.contains),
            picking: !selection.isEmpty,
            click: { false },
            toggle: {
                selection.toggle(all: ids)
                Haptics.perform(.alignment, "select")
            }
        )
    }
}

/// A group's header row inside the Needs you table: its glyph (the selection mark on
/// hover), its name and how many, on a faint wash of the group's colour.
private struct GroupRow: View {
    let group: ActionGroup
    let count: Int
    let pick: RowPick
    @ViewState private var hovering = false

    var body: some View {
        let tint = group.tint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary)
        HStack(spacing: 10) {
            SelectMark(pick: pick, hovering: hovering) {
                Image(systemName: group.symbol)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tint)
            }
            Text(group.title)
                .font(.geist(12.5, .semibold))
                .foregroundStyle(.primary)
            Text("\(count)")
                .font(Typo.rowTime)
                .foregroundStyle(tint)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.inset)
        .frame(height: 36)
        .background((group.tint ?? .white).opacity(group.tint == nil ? 0.03 : 0.07))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityLabel("\(group.title), \(count)")
    }
}

/// The running agents as a board: each row ends in its six steps as named pills, the one
/// in play tinted, so where each session is and who has it reads without opening it.
struct AgentsSection: View {
    @Environment(Store.self) private var store
    let running: [Session]
    let now: Date
    @ViewState private var selection = RowSelection()
    @ViewState private var confirmingStop = false

    var body: some View {
        let order = running.map(\.id)
        VStack(alignment: .leading, spacing: 8) {
            PickingHeader(selection: $selection, order: order) {
                SectionHeader(title: "Agents", count: running.count)
            } actions: {
                stopActions
            }
            .padding(.horizontal, Metrics.inset)
            VStack(spacing: 0) {
                ForEach(running) { session in
                    Hairline()
                    JobRow(session: session, now: now, pick: $selection.pick(session.id, in: order))
                        .transition(.opacity)
                }
                Hairline()
            }
            .animation(Easing.state, value: order)
        }
        .onChange(of: selection.isEmpty) { confirmingStop = false }
    }

    @ViewBuilder
    private var stopActions: some View {
        let picked = running.filter { selection.contains($0.id) && !store.isBusy($0.id) }
        if confirmingStop {
            ConfirmButtons(confirmLabel: picked.count == 1 ? "Stop session" : "Stop \(picked.count) sessions") {
                confirmingStop = false
                picked.forEach(store.stop)
                Haptics.perform(.alignment, "agents.bulk")
                selection.clear()
            } onCancel: {
                confirmingStop = false
            }
        } else {
            Button(role: .destructive) {
                confirmingStop = true
            } label: {
                Text("Stop…").foregroundStyle(Ink.red)
            }
            .buttonStyle(.stage(.secondary, compact: true))
            .disabled(picked.isEmpty)
        }
    }
}

/// Alerts that have settled (finished sessions, teammates' claims, dismissed cards), newest
/// first, as a log: when on the left, what happened beside it. Alerts nothing was done
/// about (filtered by a rule, ignored by Jev) fold into one row at the end, there to check
/// Jev's calls. Nothing at all while none have settled.
struct RecentSection: View {
    @Environment(Store.self) private var store
    let snapshot: Snapshot
    let now: Date
    @ViewState private var showAll = false
    @ViewState private var showQuiet = false
    @ViewState private var selection = RowSelection()

    private static let limit = 8

    var body: some View {
        let settled = snapshot.settledAlerts
        let loud = settled.filter { !$0.outcome.isQuiet }
        let quiet = settled.filter(\.outcome.isQuiet)
        let shown = showAll ? loud : Array(loud.prefix(Self.limit))
        let hidden = loud.count - shown.count
        let rows = shown + (showQuiet ? quiet : [])
        let order = rows.map(\.id)
        if !settled.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                PickingHeader(selection: $selection, order: order) {
                    SectionHeader(title: "Recent")
                } actions: {
                    bulkActions
                }
                .padding(.horizontal, Metrics.inset)
                VStack(spacing: 0) {
                    ForEach(shown) { alert in
                        Hairline()
                        row(alert, order: order)
                    }
                    if !quiet.isEmpty {
                        Hairline()
                        QuietFold(count: quiet.count, open: showQuiet) {
                            withAnimation(.snappy(duration: 0.2)) { showQuiet.toggle() }
                        }
                        if showQuiet {
                            ForEach(quiet) { alert in
                                Hairline()
                                row(alert, order: order)
                            }
                        }
                    }
                    Hairline()
                }
                .animation(Easing.state, value: order)
                if hidden > 0 || showAll {
                    Button(showAll ? "Show less" : "Show \(hidden) more") {
                        withAnimation(.snappy(duration: 0.2)) { showAll.toggle() }
                    }
                    .buttonStyle(.stage(.secondary, compact: true))
                    .accessibilityIdentifier("recent.showMore")
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }

    private func row(_ alert: AlertView, order: [String]) -> some View {
        AlertRow(alert: alert, session: snapshot.session(id: alert.sessionId), now: now, pick: $selection.pick(alert.id, in: order))
            .transition(.opacity)
    }

    /// Judge Jev's calls in one go, or start agents on alerts it let through.
    @ViewBuilder
    private var bulkActions: some View {
        let picked = snapshot.alerts.filter { selection.contains($0.id) && !store.isBusy($0.id) }
        let investigable = picked.filter { snapshot.session(id: $0.sessionId)?.isActive != true }
        if !investigable.isEmpty {
            Button("Investigate \(investigable.count)") {
                investigable.forEach(store.investigate)
                Haptics.perform(.alignment, "recent.bulk")
                selection.clear()
            }
            .buttonStyle(.stage(.secondary, compact: true))
            .help("Start an agent on each, whatever Jev decided")
        }
        Menu {
            Button {
                picked.forEach { store.feedback($0, .good) }
                selection.clear()
            } label: {
                Label("Good call", systemImage: "hand.thumbsup")
            }
            Button {
                picked.forEach { store.feedback($0, .bad) }
                selection.clear()
            } label: {
                Label("Bad call", systemImage: "hand.thumbsdown")
            }
        } label: {
            Text("Rate")
        }
        .menuStyle(.button)
        .buttonStyle(.stage(.secondary, compact: true))
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(picked.isEmpty)
        .help("Tell Jev whether it triaged these right")
    }
}

/// The folded alerts' row: how many, and a chevron that turns as it opens.
private struct QuietFold: View {
    let count: Int
    let open: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 10) {
                Text(count == 1 ? "1 filtered or ignored" : "\(count) filtered or ignored")
                    .font(Typo.rowDetail)
                    .foregroundStyle(.tertiary)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
            .padding(.leading, AlertRow.leading + AlertRow.timeWidth + 10)
            .padding(.trailing, Metrics.inset)
            .frame(height: 42)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle())
        .accessibilityLabel(open ? "Hide \(count) filtered or ignored alerts" : "Show \(count) filtered or ignored alerts")
        .accessibilityIdentifier("recent.quietFold")
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
