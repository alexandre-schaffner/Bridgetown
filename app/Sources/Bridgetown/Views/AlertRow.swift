import SwiftUI

struct AlertRow: View {
    @Environment(Store.self) private var store
    let alert: AlertView
    let session: Session?
    let now: Date
    @ViewState private var hovering = false

    /// Jev's call can be labelled right here, as in the detail: the thumbs take the time's
    /// place while the pointer is on the row. Rule decisions had no call to judge.
    private var offersFeedback: Bool { alert.triage.jev != nil }

    var body: some View {
        Button { store.show(.alert(alert.id)) } label: { content }
            .buttonStyle(RowButtonStyle())
            .overlay(alignment: .trailing) {
                if offersFeedback && hovering {
                    FeedbackThumbs(alert: alert)
                        .padding(.trailing, 8)
                        .transition(.opacity)
                }
            }
            .onHover { hovering = $0 }
            .animation(Easing.quick, value: hovering)
            .help(tooltip)
            .accessibilityElement(children: .combine)
            .accessibilityHint("Shows how this alert was triaged and how it ended")
            .contextMenu { menu }
            .opacity(store.isBusy(alert.id) ? 0.5 : 1)
            .animation(Easing.quick, value: store.isBusy(alert.id))
    }

    private var content: some View {
        let glyph = OutcomeGlyph(alert.outcome, session: session)
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: glyph.symbol)
                .font(.geist(12, .medium))
                .foregroundStyle(glyph.style)
                .frame(width: 16)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4.5 }

            VStack(alignment: .leading, spacing: 1) {
                Text(alert.title)
                    .font(.geist(12.5))
                    .foregroundStyle(glyph.dimmed ? .secondary : .primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text("\(Format.channel(alert.channelName)) · \(alert.outcome.headline)")
                    .font(.geist(11))
                    .foregroundStyle(glyph.dimmed ? .tertiary : .secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            HStack(spacing: 4) {
                if let fb = alert.feedback, fb != .unknown {
                    Image(systemName: fb == .good ? "hand.thumbsup.fill" : "hand.thumbsdown.fill")
                        .font(.geist(9))
                        .foregroundStyle(.tertiary)
                }
                Text(Format.relative(alert.receivedAt, now: now))
                    .font(Typo.time)
                    .foregroundStyle(.tertiary)
            }
            .opacity(offersFeedback && hovering ? 0 : 1)
            // Room for the thumbs, so the title truncates before them rather than under them.
            .frame(minWidth: offersFeedback && hovering ? 52 : 0, alignment: .trailing)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var menu: some View {
        Button("Show details") { store.show(.alert(alert.id)) }
        if let id = alert.sessionId, store.snapshot?.session(id: id) != nil {
            Button("Show session") { store.show(.session(id)) }
        }
        Divider()
        Button("Investigate anyway") { store.investigate(alert) }
            .disabled(session?.isActive == true)
        Divider()
        Button {
            store.feedback(alert, .good)
        } label: {
            Label("Good call", systemImage: alert.feedback == .good ? "checkmark" : "hand.thumbsup")
        }
        Button {
            store.feedback(alert, .bad)
        } label: {
            Label("Bad call", systemImage: alert.feedback == .bad ? "checkmark" : "hand.thumbsdown")
        }
        Divider()
        Button(alert.permalinkLabel) { SystemActions.open(alert.permalink) }
            .disabled(alert.permalink == nil)
    }

    private var tooltip: String {
        var lines = [alert.triage.reason]
        if let jev = alert.triage.jev {
            lines.append(
                "Actionable \(Format.percent(jev.actionable)) · Agent-resolvable \(Format.percent(jev.agentResolvable)) · Human on it \(Format.percent(jev.humanOnIt))"
            )
            lines.append(
                "\(jev.kindLabel) (\(Format.percent(jev.kindConfidence))) · \(jev.depth.rawValue) · urgency \(jev.urgencyLabel)"
            )
        } else {
            lines.append("Decided by rule")
        }
        if !alert.summary.isEmpty { lines.insert(alert.summary, at: 0) }
        return lines.joined(separator: "\n")
    }
}
