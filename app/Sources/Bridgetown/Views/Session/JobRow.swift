import SwiftUI

/// A session in the overview's Agents list, in two lines: status dot, title and elapsed
/// time; then what it's doing, and the six steps without labels. The full card
/// (`SessionRow`) is in the session and alert details.
struct JobRow: View {
    @Environment(Store.self) private var store
    let session: Session
    let now: Date

    var body: some View {
        Button { store.show(.session(session.id)) } label: { content }
            .buttonStyle(RowButtonStyle())
            .help(session.headline)
            .accessibilityElement(children: .combine)
            .accessibilityHint("Shows session details")
            .contextMenu {
                Button("Show details") { store.show(.session(session.id)) }
                if session.prUrl != nil { Button("Open PR") { SystemActions.open(session.prUrl) } }
                if session.slackThreadUrl != nil { Button("Open Slack thread") { SystemActions.open(session.slackThreadUrl) } }
            }
    }

    private var content: some View {
        HStack(alignment: .top, spacing: 8) {
            HolderDot(session: session)
                .padding(.top, 5)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(session.title)
                        .font(.geist(12.5, .medium))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    Text(Format.duration(from: session.startedAt, to: now))
                        .font(Typo.time)
                        .foregroundStyle(.tertiary)
                }
                HStack(alignment: .center, spacing: 8) {
                    Text(subtitle)
                        .font(.geist(11))
                        .foregroundStyle(session.tone.isQuiet ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    PhaseStepper(session: session, showsLabels: false)
                        .frame(width: 72)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// "Running · Bash bun test…": the daemon's headline, then what the agent is doing if
    /// that adds anything. The channel is in the detail.
    private var subtitle: String {
        var parts = [session.headline]
        let detail = Markdown.plain(session.statusDetail)
        if !detail.isEmpty, !session.headline.localizedCaseInsensitiveContains(detail) { parts.append(detail) }
        return parts.joined(separator: " · ")
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
