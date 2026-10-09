import SwiftUI

// The overview's parts, laid out side by side in the open island (`IslandOpenView`).

extension Snapshot {
    /// Nothing waiting, running or received yet: the overview shows `EmptyState` instead.
    var isQuiet: Bool { actions.isEmpty && activeSessions.isEmpty && alerts.isEmpty }

    var watchedChannelCount: Int { settings.channels.filter(\.enabled).count }

    /// Active sessions with no card in "Needs you": a card already stands for the rest.
    /// Newest started first, and only that: the daemon lists them by their last update, so
    /// every step an agent took would move its row.
    var inFlightSessions: [Session] {
        let carded = Set(actions.compactMap(\.sessionId))
        return activeSessions
            .filter { !carded.contains($0.id) }
            .sorted { ($0.startedAt, $0.id) > ($1.startedAt, $1.id) }
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

/// What is picked in the overview's lists, held above them so that one list picks at a
/// time: starting a pick in one clears the others, so only one selection header is ever
/// up, and its actions can only mean those rows. Escape clears it.
struct OverviewPicks: Equatable {
    var needsYou = RowSelection() {
        didSet { if !needsYou.isEmpty { agents.clear(); recent.clear() } }
    }
    var agents = RowSelection() {
        didSet { if !agents.isEmpty { needsYou.clear(); recent.clear() } }
    }
    var recent = RowSelection() {
        didSet { if !recent.isEmpty { needsYou.clear(); agents.clear() } }
    }

    var isEmpty: Bool { needsYou.isEmpty && agents.isEmpty && recent.isEmpty }
}

/// What's waiting on you, as one full-width table under the decision each row asks for (Answer,
/// Ship, Investigate, Retry or close). A row is its subject and its age; its button shows
/// on hover, since the group already names the verb. The one you open shows in full.
struct NeedsYouSection: View {
    @Environment(Store.self) private var store
    let snapshot: Snapshot
    @Binding var selection: RowSelection
    @ViewState private var expandedAction: String?
    @ViewState private var confirmingClose = false

    /// A line of the table: a group's header, or a card under it.
    private enum Row: Identifiable {
        case group(ActionGroup, ids: [String])
        case action(Action)

        var id: String {
            switch self {
            case let .group(group, _): "group.\(group)"
            case let .action(action): action.id
            }
        }
    }

    var body: some View {
        let groups = snapshot.actionGroups
        let order = groups.flatMap { $0.actions.map(\.id) }
        let rows = groups.flatMap { entry in
            [Row.group(entry.group, ids: entry.actions.map(\.id))] + entry.actions.map(Row.action)
        }
        let closes = picked.filter(\.dismissCloses).count
        VStack(alignment: .leading, spacing: 8) {
            PickingHeader(selection: $selection, order: order, confirming: $confirmingClose) {
                SectionHeader(title: "Needs you", count: snapshot.actions.count)
            } actions: {
                bulkActions
            } prompt: {
                ConfirmPrompt(
                    question: closes == 1 ? "Close 1 session without a fix?" : "Close \(closes) sessions without a fix?",
                    label: "Close",
                    isPresented: $confirmingClose
                ) {
                    finish { picked.forEach(store.dismiss) }
                }
            }
            .padding(.horizontal, Metrics.inset)
            // The cards that close their session left or went in flight while it asked: it
            // gives way to the selection's own buttons rather than ask to close none.
            .onChange(of: closes == 0) { _, none in if none { confirmingClose = false } }
            RowList(data: rows) { row in
                switch row {
                case let .group(group, ids):
                    GroupRow(group: group, count: ids.count, pick: groupPick(ids))
                case let .action(action):
                    ActionRow(action: action, expanded: expandedAction == action.id, pick: $selection.pick(action.id, in: order)) {
                        Haptics.perform(.alignment, "needsYou.toggle")
                        withAnimation(Easing.state) {
                            expandedAction = expandedAction == action.id ? nil : action.id
                        }
                    }
                }
            }
        }
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
        Button(closes > 0 ? selection.label("Close", acting: picked.count, asks: true) : selection.label("Dismiss", acting: picked.count)) {
            if closes > 0 { confirmingClose = true } else { finish { picked.forEach(store.dismiss) } }
        }
        .accessibilityIdentifier("needsYou.dismissPicked")
        .buttonStyle(.stage(.secondary))
        .disabled(picked.isEmpty)
        .help(closes > 0 ? "Some of these close their session without a fix" : "Dismiss the selected cards")
        if let label = picked.sharedPrimary {
            Button(selection.label(label, acting: picked.count)) {
                finish { picked.forEach { store.resolve($0) } }
            }
            .buttonStyle(.stage(.primary))
        }
    }

    private func finish(_ act: () -> Void) {
        act()
        Haptics.perform(.alignment, "needsYou.bulk")
        selection.clear()
    }

    /// A group's header picks or unpicks the whole group. It opens nothing, so it never
    /// takes a click as a pick.
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
/// hover), its name and how many, on a faint band. Colour stays on the glyph and count.
private struct GroupRow: View {
    let group: ActionGroup
    let count: Int
    let pick: RowPick

    var body: some View {
        let tint = group.tint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary)
        TableRow(pick: pick, open: nil) { hovering in
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
                    .font(Typo.time)
                    .foregroundStyle(tint)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Metrics.inset)
            .frame(height: 36)
            .background(Ink.band)
        } menu: {
            EmptyView()
        }
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
    @Binding var selection: RowSelection
    @ViewState private var confirmingStop = false

    private var picked: [Session] { running.filter { selection.contains($0.id) && !store.isBusy($0.id) } }

    var body: some View {
        let order = running.map(\.id)
        VStack(alignment: .leading, spacing: 8) {
            PickingHeader(selection: $selection, order: order, confirming: $confirmingStop) {
                SectionHeader(title: "Agents", count: running.count)
            } actions: {
                Button(selection.label("Stop", acting: picked.count, asks: true)) { confirmingStop = true }
                    .buttonStyle(.stage(.secondary))
                    .disabled(picked.isEmpty)
                    .help("Stop the selected sessions")
                    .accessibilityIdentifier("agents.stopPicked")
            } prompt: {
                let picked = picked
                ConfirmPrompt(
                    question: picked.count == 1 ? "Stop 1 session?" : "Stop \(picked.count) sessions?",
                    label: "Stop",
                    isPresented: $confirmingStop
                ) {
                    picked.forEach(store.stop)
                    Haptics.perform(.alignment, "agents.bulk")
                    selection.clear()
                }
            }
            .padding(.horizontal, Metrics.inset)
            RowList(data: running) { session in
                JobRow(session: session, pick: $selection.pick(session.id, in: order))
            }
        }
    }
}

/// Alerts that have settled (finished sessions, teammates' claims, dismissed cards), newest
/// first, as a log. Past the first eight, a row shows the rest. Alerts nothing was done
/// about (filtered by a rule, ignored by Jev) fold into one row at the end, there to check
/// Jev's calls. Clear sweeps them all off the overview, picked rows go the same way, and
/// Undo brings the last sweep back for a few seconds. Nothing at all while none are left.
struct RecentSection: View {
    @Environment(Store.self) private var store
    let snapshot: Snapshot
    @Binding var selection: RowSelection
    @AppStorage("recentSweep") private var swept = RecentSweep()
    @ViewState private var showAll = false
    @ViewState private var showQuiet = false
    /// The last sweep, while it can be undone.
    @ViewState private var lastSweep: [AlertView] = []

    private static let limit = 8
    private static let undoFor: Duration = .seconds(8)

    /// A line of the table: an alert, or a fold that shows more of them.
    private enum Row: Identifiable {
        case alert(AlertView)
        /// The loud alerts past the limit.
        case more(hidden: Int)
        /// The filtered and ignored alerts.
        case quiet(count: Int)

        var id: String {
            switch self {
            case let .alert(alert): alert.id
            case .more: "fold.more"
            case .quiet: "fold.quiet"
            }
        }
    }

    /// Settled and not swept.
    private var listed: [AlertView] {
        snapshot.settledAlerts.filter { !swept.contains($0) }
    }

    private func rows(_ listed: [AlertView]) -> [Row] {
        let loud = listed.filter { !$0.outcome.isQuiet }
        let quiet = listed.filter(\.outcome.isQuiet)
        var rows = (showAll ? loud : Array(loud.prefix(Self.limit))).map(Row.alert)
        if loud.count > Self.limit { rows.append(.more(hidden: loud.count - Self.limit)) }
        if !quiet.isEmpty { rows.append(.quiet(count: quiet.count)) }
        if showQuiet { rows += quiet.map(Row.alert) }
        return rows
    }

    var body: some View {
        let listed = listed
        let rows = rows(listed)
        let order = rows.compactMap { row -> String? in
            if case let .alert(alert) = row { alert.id } else { nil }
        }
        Group {
            if !rows.isEmpty || !lastSweep.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    PickingHeader(selection: $selection, order: order) {
                        SectionHeader(title: "Recent", count: listed.count) {
                            sweepLink(listed)
                        }
                    } actions: {
                        bulkActions
                    }
                    .padding(.horizontal, Metrics.inset)
                    if rows.isEmpty {
                        Text("Cleared. Alerts land here again as they settle.")
                            .font(Typo.body)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, Metrics.inset)
                            .padding(.vertical, 4)
                    } else {
                        RowList(data: rows) { row in
                            self.row(row, order: order)
                        }
                    }
                }
            }
        }
        // The daemon lists the last 30 alerts; what it no longer lists needs no sweeping.
        .onChange(of: snapshot.alerts, initial: true) { _, alerts in
            var kept = swept
            kept.keep(only: alerts)
            if kept != swept { swept = kept }
        }
        .task(id: lastSweep.map(\.id)) {
            guard !lastSweep.isEmpty else { return }
            try? await Task.sleep(for: Self.undoFor)
            if !Task.isCancelled { lastSweep = [] }
        }
    }

    @ViewBuilder
    private func row(_ row: Row, order: [String]) -> some View {
        switch row {
        case let .alert(alert):
            AlertRow(
                alert: alert,
                session: snapshot.session(id: alert.sessionId),
                pick: $selection.pick(alert.id, in: order),
                sweep: { sweep([alert]) }
            )
        case let .more(hidden):
            FoldRow(title: showAll ? "Show fewer" : "Show \(hidden) more", open: showAll, leading: AlertRow.textColumn) {
                withAnimation(Easing.state) { showAll.toggle() }
            }
            .accessibilityIdentifier("recent.showMore")
        case let .quiet(count):
            FoldRow(title: count == 1 ? "1 filtered or ignored" : "\(count) filtered or ignored", open: showQuiet, leading: AlertRow.textColumn) {
                withAnimation(Easing.state) { showQuiet.toggle() }
            }
            .accessibilityLabel(showQuiet ? "Hide \(count) filtered or ignored alerts" : "Show \(count) filtered or ignored alerts")
            .accessibilityIdentifier("recent.quietFold")
        }
    }

    /// Clear, or Undo while the last sweep can be taken back.
    @ViewBuilder
    private func sweepLink(_ listed: [AlertView]) -> some View {
        if !lastSweep.isEmpty {
            TextLink("Undo") { undoSweep() }
                .font(Typo.label)
                .help(lastSweep.count == 1 ? "Bring the cleared alert back" : "Bring the \(lastSweep.count) cleared alerts back")
                .accessibilityIdentifier("recent.undoSweep")
        } else if !listed.isEmpty {
            TextLink("Clear") { sweep(listed) }
                .font(Typo.label)
                .help("Clear every alert from Recent. New ones still come in.")
                .accessibilityIdentifier("recent.sweep")
        }
    }

    /// Investigate the picked alerts whatever Jev decided, or clear them.
    @ViewBuilder
    private var bulkActions: some View {
        let picked = listed.filter { selection.contains($0.id) }
        let investigable = picked.filter { !store.isBusy($0.id) && snapshot.session(id: $0.sessionId)?.isActive != true }
        Button(selection.label("Clear", acting: picked.count)) { sweep(picked) }
            .buttonStyle(.stage(.secondary))
            .disabled(picked.isEmpty)
            .help("Clear the selected alerts from Recent")
            .accessibilityIdentifier("recent.sweepPicked")
        Button(selection.label("Investigate", acting: investigable.count)) {
            investigable.forEach(store.investigate)
            Haptics.perform(.alignment, "recent.bulk")
            selection.clear()
        }
        .buttonStyle(.stage(.secondary))
        .disabled(investigable.isEmpty)
        .help("Start an agent on each, whatever Jev decided")
    }

    private func sweep(_ alerts: [AlertView]) {
        guard !alerts.isEmpty else { return }
        Haptics.perform(.alignment, "recent.sweep")
        withAnimation(Easing.state) {
            swept.sweep(alerts)
            lastSweep = alerts
        }
        selection.clear()
    }

    private func undoSweep() {
        withAnimation(Easing.state) {
            swept.restore(lastSweep)
            lastSweep = []
        }
    }
}
