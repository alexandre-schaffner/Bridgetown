import SwiftUI

/// A Grafana board as one grid, two cells a row, hairlines between; or, in a narrow
/// column, as a lead and a list: the panel spiking hardest (or the first) large, the rest
/// one line each. Counts are bars, gauges lines, spikes amber against a dashed rule at
/// the window's median. Hovering one panel moves a shared crosshair across all of
/// them, as in Grafana, and each value rolls to that time. Deploys are dashed rules (red
/// when they failed), the alert that opened the board is an orange rule. Clicking a panel
/// opens it in place (in the grid it takes its row to itself), with a taller chart, its
/// peak, usual level and low, each series, and a link to its dashboard in Grafana.
struct BoardView: View {
    let board: Board
    var maxDeploys = 3
    /// A lead and a list rather than two cells a row: for a narrow column, where a
    /// half-width cell squeezes its chart.
    var rows = false

    @ViewState private var hover: Date?
    /// A panel clicked in the list, leading until another is.
    @ViewState private var pinned: String?
    /// The panel opened in place, if any.
    @ViewState private var expanded: String?
    @Environment(\.now) private var now

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let error = board.error {
                BoardMessage(symbol: "chart.xyaxis.line", text: error)
            } else {
                if rows, let lead = board.panels.first(where: { $0.id == pinned }) ?? board.lead {
                    VStack(spacing: 0) {
                        MiniPanel(panel: lead, board: board, hover: $hover, layout: expanded == lead.id ? .detail : .lead) {
                            toggle(lead.id)
                        }
                        .id(lead.id)
                        .transition(.opacity)
                        ForEach(board.panels.filter { $0.id != lead.id }) { panel in
                            Hairline()
                            MiniPanel(panel: panel, board: board, hover: $hover, layout: .line) {
                                Haptics.perform(.alignment, "board.lead")
                                // An open lead stays open as another takes its place.
                                if expanded != nil { expanded = panel.id }
                                pinned = panel.id
                                // The row leaves from under the pointer, so its chart never
                                // hears the pointer go: the crosshair would stay where it was.
                                hover = nil
                            }
                        }
                    }
                    .tableFrame()
                    .animation(Easing.state, value: lead.id)
                    .animation(Easing.state, value: expanded)
                } else {
                    CellGrid(items: board.panels, wide: expanded) { panel in
                        MiniPanel(panel: panel, board: board, hover: $hover, layout: panel.id == expanded ? .detail : .cell) {
                            toggle(panel.id)
                        }
                    }
                    .animation(Easing.state, value: expanded)
                }
            }
            Group {
                if !board.deploys.isEmpty {
                    DeployList(deploys: board.deploys, limit: maxDeploys)
                }
                footer
            }
            .padding(.horizontal, Metrics.inset)
        }
    }

    private func toggle(_ id: String) {
        Haptics.perform(.alignment, "board.expand")
        expanded = expanded == id ? nil : id
        // The chart under the pointer is replaced by one of another size; the next move over
        // it sets the crosshair again.
        hover = nil
    }

    private var footer: some View {
        HStack(spacing: 4) {
            if let hover {
                Text(hover, format: Format.clock)
                    .foregroundStyle(.secondary)
            } else {
                Text(window)
            }
            Text("· counts per \(board.stepLabel)")
            Spacer(minLength: 0)
            Text("Grafana · \(Format.ago(board.fetchedAt, now: now))")
        }
        .font(.geist(11.5).monospacedDigit())
        .foregroundStyle(.tertiary)
        .lineLimit(1)
    }

    /// "Last hour", "Last 6h", or "03:00 – 12:00" around an alert.
    private var window: String {
        let hours = Int((board.to.timeIntervalSince(board.from) / 3600).rounded())
        if board.marker == nil, board.endsNow(at: now) {
            return hours <= 1 ? "Last hour" : "Last \(hours)h"
        }
        return "\(board.from.formatted(Format.clock)) – \(board.to.formatted(Format.clock))"
    }
}

// MARK: Deploys

private struct DeployList: View {
    let deploys: [Board.Deploy]
    let limit: Int
    @Environment(\.now) private var now

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(deploys.prefix(limit)) { deploy in
                HStack(spacing: 6) {
                    Image(systemName: deploy.status == .failed ? "xmark.octagon.fill" : "arrow.up.circle")
                        .font(.geist(11.5))
                        .foregroundStyle(deploy.status == .failed ? AnyShapeStyle(Ink.red) : AnyShapeStyle(.secondary))
                        .frame(width: 14)
                    Text("\(deploy.image) \(deploy.version)")
                        .font(.geist(12.5, .medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(deploy.status == .failed ? "failed at \(deploy.stage)" : "deployed · \(deploy.stage)")
                        .font(.geist(12))
                        .foregroundStyle(deploy.status == .failed ? AnyShapeStyle(Ink.red) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(Format.relative(deploy.at, now: now))
                        .font(Typo.rowTime)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
                .accessibilityElement(children: .combine)
            }
            if deploys.count > limit {
                Text("\(deploys.count - limit) more deploy\(deploys.count - limit == 1 ? "" : "s")")
                    .font(.geist(11.5))
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 20)
            }
        }
    }
}

// MARK: States

/// Four placeholder panels while the daemon queries Grafana (a cold board can take 30s).
struct BoardSkeleton: View {
    var count = 4

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            CellGrid(items: (0..<count).map(SkeletonCell.init)) { _ in
                VStack(alignment: .leading, spacing: 12) {
                    RoundedRectangle(cornerRadius: 2).fill(Ink.track).frame(width: 70, height: 8)
                    RoundedRectangle(cornerRadius: 3).fill(Ink.track.opacity(0.6)).frame(height: 50)
                }
                .padding(.horizontal, Metrics.inset)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .modifier(Pulse(active: true))
            }
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Querying Grafana…")
            }
            .font(.geist(11))
            .foregroundStyle(.tertiary)
            .padding(.horizontal, Metrics.inset)
        }
        .accessibilityLabel("Loading Grafana charts")
    }
}

private struct SkeletonCell: Identifiable {
    let id: Int
}

struct BoardMessage: View {
    let symbol: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol)
                .font(.geist(12))
                .foregroundStyle(.secondary)
            Text(text)
                .font(.geist(12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.inset)
        .padding(.vertical, 12)
        .tableFrame()
    }
}
