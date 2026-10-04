import SwiftUI

/// A session as a card: channel, title, the six steps and the status line. Used in
/// Running and, for the alert it belongs to, in the alert detail.
struct SessionRow: View {
    @Environment(Store.self) private var store
    let session: Session
    let now: Date
    /// Tapping the card. Nil when there's nothing to open (the session has aged out of
    /// the snapshot), and the card is not a button then.
    var onOpen: (() -> Void)?

    @ViewState private var hovering = false
    @ViewState private var confirmingStop = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            main
            if confirmingStop {
                HStack(spacing: 8) {
                    Text("Stop this session?")
                        .font(.geist(11))
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    ConfirmButtons(confirmLabel: "Stop session") {
                        confirmingStop = false
                        store.stop(session)
                    } onCancel: {
                        confirmingStop = false
                    }
                }
                .padding(.horizontal, Metrics.inset)
                .padding(.bottom, Metrics.inset)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(highlighted: hovering && onOpen != nil)
        .onHover { hovering = $0 }
        .animation(.snappy(duration: 0.18), value: confirmingStop)
        .contextMenu {
            if let onOpen { Button("Show details", action: onOpen) }
            if session.prUrl != nil { Button("Open PR") { SystemActions.open(session.prUrl) } }
            if session.slackThreadUrl != nil { Button("Open Slack thread") { SystemActions.open(session.slackThreadUrl) } }
            if session.isActive {
                Divider()
                Button("Stop session…", role: .destructive) { confirmingStop = true }
            }
        }
    }

    @ViewBuilder
    private var main: some View {
        if let onOpen {
            Button(action: onOpen) { content }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Shows session details")
        } else {
            content
                .accessibilityElement(children: .combine)
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    ChannelChip(name: session.channelName)
                    Spacer(minLength: 0)
                    Text(Format.duration(from: session.startedAt, to: session.isActive ? now : session.updatedAt))
                        .font(Typo.time)
                        .foregroundStyle(.tertiary)
                    if onOpen != nil {
                        Image(systemName: "chevron.right")
                            .font(.geist(10, .semibold))
                            .foregroundStyle(.tertiary)
                            .opacity(hovering ? 1 : 0.6)
                    }
                }
                Text(session.title)
                    .font(.geist(13, .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            PhaseStepper(session: session)

            VStack(alignment: .leading, spacing: 3) {
                StatusLine(session: session, size: 11, lineLimit: session.isActive ? 1 : 2)
                Group {
                    if let channel = session.reviewChannel, session.status == .ci {
                        ReviewRequestedChip(channel: channel)
                    } else if !session.statusDetail.isEmpty {
                        Text(session.statusDetail)
                            .font(.geist(11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                .padding(.leading, 12)  // under the headline, past the dot
            }
        }
        .padding(Metrics.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(RoundedRectangle(cornerRadius: Metrics.cardRadius))
    }
}

/// Replaces the activity line while CI runs and a human review is pending.
private struct ReviewRequestedChip: View {
    let channel: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "person.crop.circle.badge.checkmark")
                .font(.geist(10))
            Text("Review requested · #\(channel)")
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .font(.geist(11))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: Ink.tagRadius))
    }
}
