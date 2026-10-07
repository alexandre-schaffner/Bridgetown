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

/// What is picked in each of the overview's lists, held above them so one Escape clears
/// every list at once rather than one a press.
struct OverviewPicks: Equatable {
    var needsYou = RowSelection()
    var agents = RowSelection()
    var recent = RowSelection()

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
        Button(closes > 0 ? "Close…" : "Dismiss") {
            if closes > 0 { confirmingClose = true } else { finish { picked.forEach(store.dismiss) } }
        }
        .accessibilityIdentifier("needsYou.dismissPicked")
        .buttonStyle(.stage(.secondary))
        .disabled(picked.isEmpty)
        .help(closes > 0 ? "Some of these close their session without a fix" : "Dismiss the selected cards")
        if let label = picked.sharedPrimary {
            Button("\(label) \(picked.count)") {
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
                Button("Stop…") { confirmingStop = true }
                    .buttonStyle(.stage(.secondary))
                    .disabled(picked.isEmpty)
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
/// first, as a log: when on the left, what happened beside it. Past the first eight, a row
/// shows the rest. Alerts nothing was done about (filtered by a rule, ignored by Jev) fold
/// into one row at the end, there to check Jev's calls. Nothing at all while none have
/// settled.
struct RecentSection: View {
    @Environment(Store.self) private var store
    let snapshot: Snapshot
    @Binding var selection: RowSelection
    @ViewState private var showAll = false
    @ViewState private var showQuiet = false

    private static let limit = 8

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

    private var rows: [Row] {
        let settled = snapshot.settledAlerts
        let loud = settled.filter { !$0.outcome.isQuiet }
        let quiet = settled.filter(\.outcome.isQuiet)
        var rows = (showAll ? loud : Array(loud.prefix(Self.limit))).map(Row.alert)
        if loud.count > Self.limit { rows.append(.more(hidden: loud.count - Self.limit)) }
        if !quiet.isEmpty { rows.append(.quiet(count: quiet.count)) }
        if showQuiet { rows += quiet.map(Row.alert) }
        return rows
    }

    var body: some View {
        let rows = rows
        let order = rows.compactMap { row -> String? in
            if case let .alert(alert) = row { alert.id } else { nil }
        }
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                PickingHeader(selection: $selection, order: order) {
                    SectionHeader(title: "Recent")
                } actions: {
                    bulkActions
                }
                .padding(.horizontal, Metrics.inset)
                RowList(data: rows) { row in
                    switch row {
                    case let .alert(alert):
                        AlertRow(alert: alert, session: snapshot.session(id: alert.sessionId), pick: $selection.pick(alert.id, in: order))
                    case let .more(hidden):
                        FoldRow(title: showAll ? "Show fewer" : "Show \(hidden) more", open: showAll, leading: AlertRow.glyphColumn) {
                            withAnimation(Easing.state) { showAll.toggle() }
                        }
                        .accessibilityIdentifier("recent.showMore")
                    case let .quiet(count):
                        FoldRow(title: count == 1 ? "1 filtered or ignored" : "\(count) filtered or ignored", open: showQuiet, leading: AlertRow.glyphColumn) {
                            withAnimation(Easing.state) { showQuiet.toggle() }
                        }
                        .accessibilityLabel(showQuiet ? "Hide \(count) filtered or ignored alerts" : "Show \(count) filtered or ignored alerts")
                        .accessibilityIdentifier("recent.quietFold")
                    }
                }
            }
        }
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
            .buttonStyle(.stage(.secondary))
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
        .buttonStyle(.stage(.secondary))
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(picked.isEmpty)
        .help("Tell Jev whether it triaged these right")
    }
}
