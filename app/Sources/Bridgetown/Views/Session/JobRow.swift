import SwiftUI

/// A session on the overview's Agents board: status dot, title and elapsed time over
/// where it came from and what it's doing; under them, the six steps as one track in the
/// board's columns. The full card (`SessionRow`) is in the session and alert details.
struct JobRow: View {
    @Environment(Store.self) private var store
    let session: Session
    let now: Date
    var pick: RowPick?
    @ViewState private var hovering = false

    var body: some View {
        Button {
            if pick?.click() == true { return }
            store.show(.session(session.id))
        } label: {
            content
        }
        .buttonStyle(RowButtonStyle(selected: pick?.selected == true))
        .onHover { hovering = $0 }
        .help(session.headline)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Shows session details")
        .accessibilityAddTraits(pick?.selected == true ? .isSelected : [])
        .contextMenu {
            Button("Show details") { store.show(.session(session.id)) }
            if session.prUrl != nil { Button("Open PR") { SystemActions.open(session.prUrl) } }
            if session.slackThreadUrl != nil { Button("Open Slack thread") { SystemActions.open(session.slackThreadUrl) } }
            if let pick {
                Divider()
                Button(pick.selected ? "Deselect" : "Select", action: pick.toggle)
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                SelectMark(pick: pick, hovering: hovering) {
                    HolderDot(session: session)
                }
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }

                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(session.title)
                            .font(Typo.rowTitle)
                            .tracking(Typo.rowTitleTracking)
                            .lineSpacing(Typo.rowLineSpacing)
                            .lineLimit(2)
                            .truncationMode(.tail)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 4)
                        Text(Format.duration(from: session.startedAt, to: now))
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
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
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
