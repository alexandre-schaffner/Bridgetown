import SwiftUI

/// An alert in Recent, as a line of a log: how long ago in a column of its own, the
/// outcome's glyph (the selection mark on hover), the title over channel and outcome.
struct AlertRow: View {
    @Environment(Store.self) private var store
    let alert: AlertView
    let session: Session?
    var pick: RowPick?
    @Environment(\.now) private var now
    @ViewState private var hovering = false

    /// The time column: "now", "59m", "23h", "Oct 12" right-aligned, so the times read down.
    static let timeWidth: CGFloat = 40
    /// Less than the column's inset: the times' right edge, not their left, lines up.
    static let leading: CGFloat = 4

    /// Jev's call can be labelled right here, as in the detail: the thumbs take the rating's
    /// place while the pointer is on the row. Rule decisions had no call to judge.
    private var offersFeedback: Bool { alert.triage.jev != nil }

    var body: some View {
        Button {
            if pick?.click() == true { return }
            store.show(.alert(alert.id))
        } label: {
            content
        }
        .buttonStyle(RowButtonStyle(selected: pick?.selected == true))
        .overlay(alignment: .trailing) {
            if offersFeedback && hovering {
                FeedbackThumbs(alert: alert)
                    .padding(.trailing, Metrics.inset - 4)
                    .transition(.opacity)
            }
        }
        .onHover { hovering = $0 }
        .animation(Easing.quick, value: hovering)
        .help(tooltip)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Shows how this alert was triaged and how it ended")
        .accessibilityAddTraits(pick?.selected == true ? .isSelected : [])
        .contextMenu { menu }
        .opacity(store.isBusy(alert.id) ? 0.5 : 1)
        .animation(Easing.quick, value: store.isBusy(alert.id))
    }

    private var content: some View {
        let glyph = OutcomeGlyph(alert.outcome, session: session)
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(Format.relative(alert.receivedAt, now: now))
                .font(Typo.rowTime)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(width: Self.timeWidth, alignment: .trailing)

            SelectMark(pick: pick, hovering: hovering) {
                Image(systemName: glyph.symbol)
                    .font(.geist(13, .medium))
                    .foregroundStyle(glyph.style)
            }
            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }

            VStack(alignment: .leading, spacing: 4) {
                Text(alert.title)
                    .font(Typo.rowTitle)
                    .tracking(Typo.rowTitleTracking)
                    .lineSpacing(Typo.rowLineSpacing)
                    .foregroundStyle(glyph.dimmed ? .secondary : .primary)
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                (Text("\(Format.channel(alert.channelName)) · ")
                    + (glyph.dimmed ? Text(alert.outcome.headline) : alert.outcome.tone.headline(alert.outcome.headline)))
                    .font(Typo.rowDetail)
                    .foregroundStyle(glyph.dimmed ? .tertiary : .secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 4)

            ZStack(alignment: .trailing) {
                if let fb = alert.feedback, fb != .unknown {
                    Image(systemName: fb == .good ? "hand.thumbsup.fill" : "hand.thumbsdown.fill")
                        .font(.geist(9))
                        .foregroundStyle(.tertiary)
                        .accessibilityLabel(fb == .good ? "Rated a good call" : "Rated a bad call")
                }
            }
            .opacity(offersFeedback && hovering ? 0 : 1)
            // Room for the thumbs, so the title truncates before them rather than under them.
            .frame(minWidth: offersFeedback && hovering ? 52 : 0, alignment: .trailing)
        }
        .padding(.leading, Self.leading)
        .padding(.trailing, Metrics.inset)
        .padding(.vertical, 15)
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
        if let pick {
            Divider()
            Button(pick.selected ? "Deselect" : "Select", action: pick.toggle)
        }
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
