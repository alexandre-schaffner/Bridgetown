import SwiftUI

struct AlertRow: View {
    @Environment(Store.self) private var store
    let alert: AlertView
    let session: Session?
    let now: Date
    @ViewState private var hovering = false

    var body: some View {
        let glyph = OutcomeGlyph(alert.outcome, session: session)
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: glyph.symbol)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(glyph.style)
                .frame(width: 16)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4.5 }

            VStack(alignment: .leading, spacing: 1) {
                Text(alert.title)
                    .font(.system(size: 12.5))
                    .foregroundStyle(glyph.dimmed ? .secondary : .primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text("\(alert.channelName) · \(alert.outcome.headline)")
                    .font(.system(size: 11))
                    .foregroundStyle(glyph.dimmed ? .tertiary : .secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            HStack(spacing: 4) {
                if let fb = alert.feedback, fb != .unknown {
                    Image(systemName: fb == .good ? "hand.thumbsup.fill" : "hand.thumbsdown.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                }
                Text(Format.relative(alert.receivedAt, now: now))
                    .font(.system(size: 11))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                // Space is always reserved, so the time doesn't shift when it appears.
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .opacity(hovering ? 1 : 0)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        .hoverHighlight(radius: 6)
        .onHover { hovering = $0 }
        .onTapGesture { store.show(.alert(alert.id)) }
        .help(tooltip)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Shows how this alert was triaged and how it ended")
        .accessibilityAction { store.show(.alert(alert.id)) }
        .contextMenu { menu }
        .opacity(store.isBusy(alert.id) ? 0.5 : 1)
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
        Button("Open in Slack") { SystemActions.open(alert.permalink) }
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
