import SwiftUI

/// A session as a row: status dot, title and how long it ran over where it came from and
/// what it's doing; under them, the six steps as one track. On the overview's Agents
/// board, and under its alert in the alert's detail.
struct JobRow: View {
    @Environment(Store.self) private var store
    let session: Session
    var pick: RowPick?
    /// False when the session has no detail to open (aged out of the snapshot): the row is
    /// not a button then.
    var opens = true
    @Environment(\.now) private var now

    var body: some View {
        TableRow(pick: pick, open: opens ? { store.show(.session(session.id)) } : nil) { hovering in
            content(hovering)
        } menu: {
            if opens { Button("Show details") { store.show(.session(session.id)) } }
            if session.prUrl != nil { Button("Open PR") { SystemActions.open(session.prUrl) } }
            if session.slackThreadUrl != nil { Button("Open Slack thread") { SystemActions.open(session.slackThreadUrl) } }
        }
        .help(session.headline)
        .accessibilityHint(opens ? "Shows session details" : "")
        .accessibilityIdentifier("agents.row.\(session.id)")
    }

    private func content(_ hovering: Bool) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                SelectMark(pick: pick, hovering: hovering) {
                    SessionDot(session: session)
                }
                .centeredOnRowTitle()

                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(session.title).rowTitle()
                        Spacer(minLength: 4)
                        Text(session.elapsed(now: now))
                            .font(Typo.time)
                            .foregroundStyle(.tertiary)
                    }
                    subtitle.rowDetail(quiet: session.tone.isQuiet)
                }
            }
            StepTrack(session: session)
        }
        .padding(.horizontal, Metrics.inset)
        .padding(.top, 16)
        .padding(.bottom, 13)
    }

    /// "#alert-dev · Waiting on you · Asked: …": where it came from, the daemon's headline
    /// in its tone, then what the agent is doing if that adds anything.
    private var subtitle: Text {
        let text = Text("\(session.channelLabel) · ") + session.tone.headline(session.headline)
        // Once it has ended, its headline says how.
        let detail = session.isActive ? Markdown.plain(session.activity) : ""
        if !detail.isEmpty, !session.headline.localizedCaseInsensitiveContains(detail) {
            return text + Text(" · \(detail)")
        }
        return text
    }
}
