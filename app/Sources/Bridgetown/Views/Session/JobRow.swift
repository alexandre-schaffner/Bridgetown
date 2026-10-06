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
        .accessibilityHint("Shows session details")
        .accessibilityIdentifier("agents.row.\(session.id)")
    }

    private func content(_ hovering: Bool) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                SelectMark(pick: pick, hovering: hovering) {
                    HolderDot(session: session)
                }
                .centeredOnRowTitle()

                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(session.title).rowTitle()
                        Spacer(minLength: 4)
                        Text(Format.duration(from: session.startedAt, to: session.isActive ? now : session.updatedAt))
                            .font(Typo.rowTime)
                            .foregroundStyle(.tertiary)
                    }
                    subtitle
                        .font(Typo.rowDetail)
                        .lineSpacing(Typo.rowLineSpacing)
                        .lineLimit(2)
                        .truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
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
    private var subtitle: some View {
        var text = Text("\(Format.channel(session.channelName)) · ")
            + session.tone.headline(session.headline)
        let detail = Markdown.plain(session.statusDetail)
        if !detail.isEmpty, !session.headline.localizedCaseInsensitiveContains(detail) {
            text = text + Text(" · \(detail)")
        }
        return text.foregroundStyle(session.tone.isQuiet ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.secondary))
    }
}

/// Filled and pulsing while something moves (agent, CI, deploy); filled orange when it's
/// on you; a ring while it waits on someone else (reviewers, the queue).
private struct HolderDot: View {
    let session: Session

    var body: some View {
        let holder = session.holder
        Group {
            if holder?.isMoving == true || holder == .you {
                LiveDot(color: session.tone.color, live: holder?.isMoving == true, size: 7)
            } else {
                Circle()
                    .strokeBorder(Color.secondary, lineWidth: 1.5)
            }
        }
        .frame(width: 7, height: 7)
        .help(holder.map { "\($0.label.prefix(1).uppercased())\($0.label.dropFirst())" } ?? "")
    }
}
