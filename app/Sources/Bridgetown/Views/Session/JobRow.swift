import SwiftUI

/// A session in the overview's Agents list, in two lines: status dot, title and elapsed
/// time; then channel, what it's doing, and the five steps without labels. The full card
/// (`SessionRow`) is in the session and alert details.
struct JobRow: View {
    @Environment(Store.self) private var store
    let session: Session
    let now: Date

    @ViewState private var hovering = false

    var body: some View {
        Button { store.show(.session(session.id)) } label: { content }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
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
                        .font(.system(size: 12.5, weight: .medium))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    Text(Format.duration(from: session.startedAt, to: now))
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .opacity(hovering ? 1 : 0)
                }
                HStack(alignment: .center, spacing: 8) {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(session.tone.isQuiet ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    PhaseStepper(session: session, showsLabels: false)
                        .frame(width: 64)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(.quaternary.opacity(hovering ? 0.7 : 0))
        )
        .animation(.easeOut(duration: 0.12), value: hovering)
    }

    /// "#alert-dev · Running · Bash bun test…": where it came from, the daemon's headline,
    /// then what the agent is doing if that adds anything.
    private var subtitle: String {
        var parts = [Format.channel(session.channelName), session.headline]
        let detail = session.statusDetail
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
                Circle()
                    .fill(session.tone.color)
                    .modifier(Pulse(active: holder?.isMoving == true))
            } else {
                Circle()
                    .strokeBorder(holder == .reviewers ? Color.accentColor : Color.secondary, lineWidth: 1.5)
            }
        }
        .frame(width: 7, height: 7)
        .help(holder.map { "\($0.label.prefix(1).uppercased())\($0.label.dropFirst())" } ?? "")
    }
}
