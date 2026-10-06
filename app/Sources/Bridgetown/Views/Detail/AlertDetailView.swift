import SwiftUI

/// Any past alert, opened from Recent: what it was, how it ended, how Jev called it, its
/// history and the original message. Data comes from `GET /alerts/:id`; live fields
/// (outcome, feedback, the session's progress, open actions) come from the snapshot when
/// it has them.
struct AlertDetailView: View {
    @Environment(Store.self) private var store
    let alertId: String

    @ViewState private var detail = Loadable<AlertDetail>()
    @Environment(\.now) private var now

    private var alert: AlertView? { store.snapshot?.alert(id: alertId) ?? detail.value?.alert }

    private var session: Session? {
        guard let id = alert?.sessionId else { return nil }
        if let live = store.snapshot?.session(id: id) { return live }
        return detail.value?.session?.id == id ? detail.value?.session : nil
    }

    /// The snapshot carries every open action, so it is authoritative once connected.
    private var openActions: [Action] {
        if let snap = store.snapshot { return snap.actions.filter { $0.alertId == alertId } }
        return detail.value?.actions ?? []
    }

    private var events: [AlertDetail.Event] { detail.value?.events ?? [] }

    /// Refetch when anything the detail depends on changes (feedback, a new session, a
    /// dismissed card), so the history stays current. Only live data counts: what the
    /// fetch itself fills in (an aged-out session, the actions while disconnected) would
    /// change the key and fetch it all again.
    struct RefreshKey: Equatable {
        var alert: AlertView?
        var sessionUpdatedAt: Date?
        var actionIds: [String]

        init(snapshot: Snapshot?, alertId: String) {
            alert = snapshot?.alert(id: alertId)
            sessionUpdatedAt = snapshot?.session(id: alert?.sessionId)?.updatedAt
            actionIds = snapshot?.actions.filter { $0.alertId == alertId }.map(\.id) ?? []
        }
    }

    private var refreshKey: RefreshKey { RefreshKey(snapshot: store.snapshot, alertId: alertId) }

    var body: some View {
        Group {
            if let alert, detail.value != nil || detail.error != nil {
                DetailScaffold(title: alert.title, titleLineLimit: 2) {
                    sections(alert)
                } bar: {
                    bottomBar(alert)
                }
            } else {
                VStack(spacing: 0) {
                    DetailTopBar(title: alert?.title ?? "", lineLimit: 2)
                    Hairline()
                    if let error = detail.error {
                        failure(error)
                    } else {
                        // A local fetch; usually done before the first frame matters.
                        Color.clear.frame(maxHeight: .infinity)
                    }
                }
            }
        }
        .task(id: refreshKey) { await load() }
    }

    // MARK: Content

    @ViewBuilder
    private func sections(_ alert: AlertView) -> some View {
        summary(alert)
            .padding(.horizontal, Metrics.inset)
        DetailSection(title: Self.isOpen(alert, session: session, openActions: openActions) ? "Where it stands" : "How it ended") {
            howItEnded(alert)
        }
        GrafanaSection(alertId: alert.id)
        DetailSection(title: "Jev's call") {
            jevsCall(alert)
                .padding(.horizontal, Metrics.inset)
        }
        if !events.isEmpty {
            DetailSection(title: "History") {
                AlertHistory(events: events)
                    .padding(.horizontal, Metrics.inset)
            }
        }
        if let raw = detail.value?.raw, !raw.isEmpty {
            DetailSection(title: "Message") {
                // Set apart from the app's own words: a block of its own on a faint fill.
                ClampedText(markdown: Mrkdwn.markdown(raw), lineLimit: 8, size: 10.5, mono: true, lineSpacing: 1.5, moreLabel: "Show full message")
                    .id(raw)
                    .padding(.horizontal, Metrics.inset)
                    .padding(.vertical, 10)
                    .background(Ink.band)
                    .tableFrame()
            }
        }
        if let error = detail.error {
            Text("Couldn't load the full alert · \(error)")
                .font(Typo.caption)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, Metrics.inset)
        }
    }

    private func summary(_ alert: AlertView) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // With a session, "How it ended" says where it stands.
            if session == nil {
                StatusLine(headline: alert.outcome.headline, tone: alert.outcome.tone, size: 13)
            }
            // Whole, however narrow the pane: it scrolls, and the summary is what the alert says.
            if !alert.summary.isEmpty {
                Text(alert.summary)
                    .font(Typo.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            HStack(spacing: 8) {
                ChannelChip(name: alert.channelName)
                Text(Format.ago(alert.receivedAt, now: now))
                    .font(Typo.caption)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .help(alert.receivedAt.formatted(date: .abbreviated, time: .shortened))
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: How it ended

    @ViewBuilder
    private func howItEnded(_ alert: AlertView) -> some View {
        if let session {
            // A session aged out of the snapshot has no detail to open.
            JobRow(session: session, opens: store.snapshot?.session(id: session.id) != nil)
                .tableFrame()
        } else {
            // Every outcome but `session` means no agent ran. The daemon's sentence says
            // what happened instead; without one, say just that.
            Text(alert.outcome.sentence.flatMap { $0.isEmpty ? nil : $0 } ?? Self.noSessionLine(alert.outcome.kind))
                .font(Typo.strong)
                .foregroundStyle(.primary)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Metrics.inset)
        }
    }

    /// Not over yet: not triaged, a card waiting on you, or an agent still on it. Its outcome
    /// is then where it stands, not how it ended.
    static func isOpen(_ alert: AlertView, session: Session?, openActions: [Action]) -> Bool {
        alert.outcome.kind == .pending || alert.outcome.kind == .waiting || session?.isActive == true || !openActions.isEmpty
    }

    private static func noSessionLine(_ kind: AlertOutcome.Kind) -> String {
        switch kind {
        case .pending: "Not triaged yet."
        case .session: "An agent session owns it, but its details couldn't be loaded."
        default: "No agent ran."
        }
    }

    // MARK: Jev's call

    private func jevsCall(_ alert: AlertView) -> some View {
        let triage = alert.triage
        // `jev` is null both when a rule decided and when Jev was unavailable.
        let byRule = triage.jev == nil && triage.decision == .filtered
        // Shown under "How it ended" already when the daemon's sentence is the reason.
        let reason = triage.jev == nil ? triage.reason : Self.withoutScores(triage.reason)
        let showsReason = !reason.isEmpty && alert.outcome.sentence != triage.reason
        return VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(byRule ? "Decided by a rule, no model call" : triage.decision.callLabel)
                    .font(Typo.strong)
                if showsReason {
                    Text(reason)
                        .font(Typo.body)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let jev = triage.jev {
                JevScores(jev: jev)
                Text("Kind: \(jev.kindLabel) · Depth: \(jev.depth.rawValue)")
                    .font(Typo.caption)
                    .foregroundStyle(.tertiary)
                    .help("Kind confidence \(Format.percent(jev.kindConfidence)) · urgency \(jev.urgencyLabel) of 3")
            } else if !byRule {
                Text("No scores from Jev for this one")
                    .font(Typo.caption)
                    .foregroundStyle(.tertiary)
            }
            FeedbackRow(alert: alert)
        }
    }

    /// "Borderline runtime_error (actionable 62% · agent 55%)" → "Borderline runtime_error":
    /// the scores are drawn right below, so the reason doesn't repeat them.
    static func withoutScores(_ reason: String) -> String {
        guard reason.hasSuffix(")") else { return reason }
        var depth = 0
        for index in reason.indices.reversed() {
            switch reason[index] {
            case ")": depth += 1
            case "(":
                depth -= 1
                if depth == 0 {
                    guard reason[index...].contains("%") else { return reason }
                    return reason[..<index].trimmingCharacters(in: .whitespaces)
                }
            default: break
            }
        }
        return reason
    }

    // MARK: Bottom bar

    @ViewBuilder
    private func bottomBar(_ alert: AlertView) -> some View {
        Button {
            SystemActions.open(alert.permalink)
        } label: {
            Label(alert.permalinkLabel, systemImage: "arrow.up.right.square")
        }
        .buttonStyle(.stage(.secondary))
        .disabled(alert.permalink == nil)
        .help(alert.permalink == nil ? "No permalink for this message" : alert.source == .watch ? "Open the dashboard in Grafana" : "Open the message in Slack")

        Spacer(minLength: 0)

        if session?.isActive != true {
            let waiting = openActions.contains { $0.kind == .investigate }
            let button = Button(session == nil ? "Investigate" : "Investigate again") {
                store.investigate(alert)
            }
            .disabled(store.isBusy(alert.id))
            .help("Start an agent on this alert")
            // Primary only when investigating is the expected next step.
            button.buttonStyle(.stage(waiting ? .primary : .secondary))
        }
    }

    // MARK: Loading

    private func failure(_ message: String) -> some View {
        VStack(spacing: 8) {
            Text("Couldn't load this alert")
                .font(Typo.strong)
            Text(message)
                .font(Typo.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Try again") { Task { await load() } }
                .buttonStyle(.stage(.secondary))
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func load() async {
        detail = await detail.reloaded { try await store.alertDetail(id: alertId) }
    }
}

// MARK: - Feedback

private struct FeedbackRow: View {
    @Environment(Store.self) private var store
    let alert: AlertView

    private var text: String {
        switch alert.feedback {
        case .good?: "You marked this a good call"
        case .bad?: "You marked this a bad call"
        default: "Was this the right call?"
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            Text(text)
                .font(Typo.caption)
                .foregroundStyle(alert.feedback == nil ? .tertiary : .secondary)
            Spacer(minLength: 0)
            FeedbackThumbs(alert: alert)
        }
    }
}

// MARK: - History

/// Oldest first: time, a small dot, the line. No cards.
private struct AlertHistory: View {
    let events: [AlertDetail.Event]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(events.enumerated()), id: \.offset) { index, event in
                let latest = index == events.count - 1
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Circle()
                        .fill(latest ? AnyShapeStyle(.secondary) : AnyShapeStyle(Ink.track))
                        .frame(width: 5, height: 5)
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 3.5 }
                    Text(event.at, format: Format.clock)
                        .font(Typo.caption)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                        .help(event.at.formatted(date: .abbreviated, time: .standard))
                    Text(event.text)
                        .font(Typo.small)
                        .foregroundStyle(latest ? .primary : .secondary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .textSelection(.enabled)
    }
}
