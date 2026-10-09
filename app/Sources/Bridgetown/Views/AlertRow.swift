import SwiftUI

/// An alert in Recent, laid out as the other lists' rows are: the outcome's glyph (the
/// selection mark on hover) in the leading column, the title and how long ago over
/// channel and outcome. Every row is dimmed alike, as its work is done; the glyph keeps
/// its colour, and the row brightens under the pointer or once picked.
struct AlertRow: View {
    @Environment(Store.self) private var store
    let alert: AlertView
    let session: Session?
    let pick: RowPick
    /// Sweeps it out of Recent.
    let sweep: () -> Void
    @Environment(\.now) private var now

    /// Where the titles start, past the glyph column: a fold row's words line up with them.
    static let textColumn = Metrics.inset + 16 + 10

    var body: some View {
        TableRow(pick: pick, open: { store.show(.alert(alert.id)) }) { hovering in
            content(hovering)
        } menu: {
            menu
        }
        .help(tooltip)
        .accessibilityHint("Shows how this alert was triaged and how it ended")
        .accessibilityIdentifier("recent.row.\(alert.id)")
        .busy(store.isBusy(alert.id))
    }

    private func content(_ hovering: Bool) -> some View {
        let glyph = OutcomeGlyph(alert.outcome, session: session)
        let lit = hovering || pick.selected
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            SelectMark(pick: pick, hovering: hovering) {
                Image(systemName: glyph.symbol)
                    .font(.geist(13, .medium))
                    .foregroundStyle(glyph.style)
            }
            .centeredOnRowTitle()

            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(alert.title)
                        .rowTitle()
                        .foregroundStyle(lit ? .primary : .secondary)
                    Spacer(minLength: 4)
                    Text(Format.relative(alert.receivedAt, now: now))
                        .font(Typo.time)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                Text("\(alert.channelLabel) · \(alert.outcome.headline)")
                    .font(Typo.body)
                    .foregroundStyle(lit ? .secondary : .tertiary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.horizontal, Metrics.inset)
        .padding(.vertical, 15)
    }

    /// A request for the alert in flight closes what would send another: a second
    /// "Investigate" could start a second agent before the first session exists.
    @ViewBuilder
    private var menu: some View {
        let busy = store.isBusy(alert.id)
        Button("Show details") { store.show(.alert(alert.id)) }
        if let id = alert.sessionId, store.snapshot?.session(id: id) != nil {
            Button("Show session") { store.show(.session(id)) }
        }
        Divider()
        Button("Investigate anyway") { store.investigate(alert) }
            .disabled(session?.isActive == true || busy)
        Button("Clear from Recent", action: sweep)
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
