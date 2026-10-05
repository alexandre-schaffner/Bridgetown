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
            .bleedInset()
        }
    }

    private func toggle(_ id: String) {
        Haptics.perform(.alignment, "board.expand")
        expanded = expanded == id ? nil : id
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
            Text("Grafana · \(Format.ago(board.fetchedAt, now: .now))")
        }
        .font(.geist(11.5).monospacedDigit())
        .foregroundStyle(.tertiary)
        .lineLimit(1)
    }

    /// "Last hour", "Last 6h", or "03:00 – 12:00" around an alert.
    private var window: String {
        let hours = Int((board.to.timeIntervalSince(board.from) / 3600).rounded())
        if board.marker == nil, abs(board.to.timeIntervalSinceNow) < 600 {
            return hours <= 1 ? "Last hour" : "Last \(hours)h"
        }
        return "\(board.from.formatted(Format.clock)) – \(board.to.formatted(Format.clock))"
    }
}

// MARK: Panel

private struct MiniPanel: View {
    let panel: Board.Panel
    let board: Board
    @Binding var hover: Date?
    enum Layout {
        /// Half a grid row: title and value over the chart.
        case cell
        /// The board's lead: title, a large value, a full-width chart.
        case lead
        /// One line in the list under the lead: title, a small chart, the value.
        case line
        /// Opened in place: a taller chart with its times, the window's stats, each series.
        case detail
    }

    var layout: Layout = .cell
    /// A line becomes the lead; a cell or the lead opens in place, and closes again.
    var onSelect: () -> Void

    static let chartHeight: CGFloat = 54
    /// Series listed under an open panel before "n more".
    static let seriesLimit = 8
    /// The small chart in a line, and the value column after it, so values line up.
    static let lineChartWidth: CGFloat = 92
    static let lineValueWidth: CGFloat = 70

    private struct Point: Identifiable {
        let series: String
        let at: Date
        let value: Double
        var id: String { "\(series)-\(at.timeIntervalSince1970)" }
    }

    private var points: [Point] {
        panel.series.flatMap { s in
            s.points.compactMap { p in
                guard p.count == 2 else { return nil }
                return Point(series: s.label, at: Date(timeIntervalSince1970: p[0]), value: p[1])
            }
        }
    }

    private var yMax: Double {
        let top = points.map(\.value).max() ?? 0
        return top > 0 ? top * 1.15 : 1
    }

    /// The value under the shared crosshair (summed across series, like `latest`), or the latest.
    private var shown: Double? {
        guard let hover else { return panel.latest }
        let nearest = panel.series.compactMap { Board.Panel.value(of: $0, at: hover) }
        return nearest.isEmpty ? nil : nearest.reduce(0, +)
    }

    var body: some View {
        Group {
            switch layout {
            case .lead:
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        title
                        Spacer(minLength: 4)
                        context
                    }
                    value(size: 30)
                    plot(height: 72)
                        .padding(.top, 4)
                }
                .padding(.top, 16)
                .padding(.bottom, 14)
            case .line:
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        title
                        // Only when it says something: a calm list stays quiet. Kept while
                        // hovering (it shows the time then), so the row keeps its height.
                        if panel.spikeRatio != nil { context }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    plot(height: 22)
                        .frame(width: Self.lineChartWidth)
                    value(size: 14)
                        .frame(width: Self.lineValueWidth, alignment: .trailing)
                }
                .padding(.vertical, 12)
            case .cell:
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        title
                        Spacer(minLength: 2)
                        value(size: 15)
                    }
                    plot(height: Self.chartHeight)
                }
                .padding(.vertical, 14)
            case .detail:
                VStack(alignment: .leading, spacing: 10) {
                    detailHeader
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        value(size: 30)
                        context
                    }
                    VStack(spacing: 6) {
                        plot(height: 132, errorLines: nil)
                        timeAxis
                    }
                    .padding(.top, 4)
                    stats
                        .padding(.top, 8)
                    if panel.series.count > 1 { seriesList }
                }
                .padding(.top, 14)
                .padding(.bottom, 16)
            }
        }
        .padding(.horizontal, Metrics.inset)
        .contentShape(Rectangle())
        // Open, only its header and chart close it: the stats under them can be read and
        // hovered without it folding away.
        .rowHighlight(layout != .detail)
        .onTapGesture { if layout != .detail { onSelect() } }
        .contextMenu { Button("Open in Grafana") { SystemActions.open(panel.link) } }
        .help(layout == .detail ? "" : "\(panel.title) · \(layout == .line ? "show above" : "show details")")
        .accessibilityElement(children: layout == .detail ? .contain : .ignore)
        .accessibilityLabel(panel.title)
        .accessibilityValue(panel.latest.map(panel.unit.format) ?? "No data")
        .accessibilityAddTraits(.isButton)
        // What a click does, for VoiceOver and AXPress (a tap gesture answers neither):
        // shut, it opens; open, its header and chart close it.
        .accessibilityAction { onSelect() }
        .accessibilityAction(named: "Open in Grafana") { SystemActions.open(panel.link) }
    }

    // MARK: Detail

    /// The title, which closes the panel as the chart does, then Grafana and a close button.
    private var detailHeader: some View {
        HStack(alignment: .center, spacing: 10) {
            title
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture(perform: onSelect)
            Button {
                SystemActions.open(panel.link)
            } label: {
                NudgeLabel(title: "Open in Grafana", symbol: "arrow.up.right", nudge: CGSize(width: 1.5, height: -1.5))
            }
            .buttonStyle(.plain)
            .font(.geist(11.5, .medium))
            .help("This panel's dashboard over the same window, in Grafana")
            Button(action: onSelect) {
                Image(systemName: "chevron.up")
                    .font(.system(size: 9, weight: .semibold))
                    .frame(width: 20, height: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .hoverHighlight(radius: Ink.tagRadius)
            .help("Close")
            .accessibilityLabel("Close \(panel.title)")
        }
    }

    /// The window's start, middle and end under the chart; the end is "now" when it is.
    private var timeAxis: some View {
        let middle = board.from.addingTimeInterval(board.to.timeIntervalSince(board.from) / 2)
        return HStack {
            Text(board.from, format: Format.clock)
            Spacer(minLength: 4)
            Text(middle, format: Format.clock)
            Spacer(minLength: 4)
            if abs(board.to.timeIntervalSinceNow) < 600 {
                Text("now")
            } else {
                Text(board.to, format: Format.clock)
            }
        }
        .font(Typo.time)
        .foregroundStyle(.tertiary)
        .accessibilityHidden(true)
    }

    /// Peak, usual and low across the window, and for a count of events its total. Hovering a stat
    /// with a time moves the crosshair to it.
    @ViewBuilder
    private var stats: some View {
        if let summary = panel.summary {
            HStack(alignment: .top, spacing: 12) {
                stat("Peak", summary.peak.value, at: summary.peak.at)
                stat("Usual", summary.median)
                stat("Low", summary.low.value, at: summary.low.at)
                // Events add up; a gauge (pods, memory) summed over time means nothing.
                if style == .bars { stat("Total", summary.total) }
            }
        }
    }

    private func stat(_ label: String, _ value: Double, at: Date? = nil) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(Typo.label)
                .foregroundStyle(.tertiary)
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(panel.unit.format(value))
                    .font(Typo.figure(14))
                if let at {
                    Text(at, format: Format.clock)
                        .font(Typo.time)
                        .foregroundStyle(.tertiary)
                }
            }
            .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onHover { inside in
            guard let at else { return }
            hover = inside ? at : nil
        }
        .accessibilityElement(children: .combine)
    }

    private struct SeriesRow: Identifiable {
        let id: Int
        let label: String
        let latest: Double
        let current: Bool
        let shown: Double?
    }

    /// Largest first by latest value, so rows hold still as the crosshair moves.
    private var seriesRows: [SeriesRow] {
        panel.series.enumerated()
            .map { index, s in
                let latest = Board.Panel.value(of: s, at: nil) ?? 0
                return SeriesRow(id: index, label: s.label, latest: latest, current: latest > 0, shown: Board.Panel.value(of: s, at: hover))
            }
            .sorted { $0.latest > $1.latest }
    }

    /// Each series' value under the crosshair, or its latest; bright while it still reports.
    private var seriesList: some View {
        let rows = seriesRows
        return VStack(alignment: .leading, spacing: 0) {
            Hairline()
                .padding(.bottom, 6)
            ForEach(rows.prefix(Self.seriesLimit)) { row in
                HStack(spacing: 8) {
                    Circle()
                        .fill(row.current ? Ink.text : Ink.faint.opacity(0.6))
                        .frame(width: 5, height: 5)
                    Text(row.label)
                        .font(.geist(12))
                        .foregroundStyle(row.current ? .primary : .tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 8)
                    Text(row.shown.map(panel.unit.format) ?? "–")
                        .font(Typo.figure(12))
                        .foregroundStyle(row.current ? .primary : .tertiary)
                        .contentTransition(.numericText(value: row.shown ?? 0))
                        .animation(.snappy(duration: 0.22), value: row.shown)
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
            }
            if rows.count > Self.seriesLimit {
                Text("\(rows.count - Self.seriesLimit) more series")
                    .font(.geist(11.5))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 4)
                    .padding(.leading, 13)
            }
        }
    }

    private var title: some View {
        Text(panel.title)
            .font(.geist(12, .medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
    }

    /// Amber while the latest bucket is well above usual (and nothing is hovered): the
    /// panel to look at. Grey when it failed to load.
    private var valueStyle: AnyShapeStyle {
        if panel.error != nil { return AnyShapeStyle(.tertiary) }
        if hover == nil, let latest = panel.latest, BucketChart.isSpike(latest, typical: typical) {
            return AnyShapeStyle(Ink.amber)
        }
        return AnyShapeStyle(.primary)
    }

    /// Rolls like an odometer to each new value, the hovered one included.
    private func value(size: CGFloat) -> some View {
        Text(shown.map(panel.unit.format) ?? "–")
            .font(Typo.figure(size))
            .tracking(-0.3)
            .foregroundStyle(valueStyle)
            .contentTransition(.numericText(value: shown ?? 0))
            .animation(.snappy(duration: 0.22), value: shown)
            .lineLimit(1)
            .fixedSize()
    }

    /// The chart, or why there isn't one, at `height`. An error is cut to `errorLines`.
    @ViewBuilder
    private func plot(height: CGFloat, errorLines: Int? = 3) -> some View {
        if let error = panel.error {
            Text(error)
                .font(.geist(11))
                .foregroundStyle(.tertiary)
                .lineLimit(errorLines)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, minHeight: height, alignment: .topLeading)
                .help(error)
        } else if points.isEmpty {
            Text("No data in this window")
                .font(.geist(11))
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, minHeight: height, alignment: .center)
        } else {
            chart.frame(height: height)
        }
    }

    /// Counts are bars, one per bucket; gauges (latency, memory, CPU) and several series
    /// are lines.
    private var style: BucketChart.Style {
        panel.series.count == 1 && (panel.unit == .count || panel.unit == .unknown) ? .bars : .levels
    }

    /// The window's usual level, its median, for the dashed rule and the line under the value.
    private var typical: Double? { panel.typical }

    private var step: TimeInterval { Double(max(1, board.stepSeconds)) }

    /// One column per bucket across the board's window, the same for every panel, so the
    /// shared crosshair lands on the same bucket in each.
    private var columns: Int {
        max(1, Int((board.to.timeIntervalSince(board.from) / step).rounded(.up)))
    }

    private func column(of date: Date) -> Int {
        Int((date.timeIntervalSince(board.from) / step).rounded(.down))
    }

    private func fraction(of date: Date) -> Double {
        date.timeIntervalSince(board.from) / max(1, board.to.timeIntervalSince(board.from))
    }

    private var chartSeries: [BucketChart.Series] {
        let count = columns
        return panel.series.map { s in
            var values = [Double?](repeating: nil, count: count)
            for p in s.points where p.count == 2 {
                let c = column(of: Date(timeIntervalSince1970: p[0]))
                if values.indices.contains(c) { values[c] = max(values[c] ?? 0, p[1]) }
            }
            // The series still reporting bright, the rest faint: for pods by version, the
            // new tag reads as the live one.
            let reporting = panel.series.count == 1 || (s.points.last?[1] ?? 0) > 0
            return BucketChart.Series(values: values, current: reporting)
        }
    }

    /// Against the window's median: "near usual", or how far above or below it the latest
    /// value is. While hovering, the time under the crosshair instead.
    @ViewBuilder
    private var context: some View {
        Group {
            if let hover {
                Text(hover, format: Format.clock)
                    .foregroundStyle(.secondary)
            } else if let typical, let latest = panel.latest {
                let ratio = latest / typical
                if BucketChart.isSpike(latest, typical: typical) {
                    Text("↑ \(Format.decimal(ratio, digits: 1))× usual")
                        .foregroundStyle(Ink.amber)
                } else if ratio <= 0.55 {
                    Text("↓ \(Format.decimal(ratio, digits: 1))× usual")
                        .foregroundStyle(.secondary)
                } else {
                    Text("near usual")
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .font(.geist(11.5, .medium).monospacedDigit())
        .lineLimit(1)
        .contentTransition(.numericText())
    }

    private var chart: some View {
        let hoveredColumn = hover.map(column(of:))
        return BucketChart(
            series: chartSeries,
            style: style,
            yMax: yMax,
            typical: typical,
            hovered: hoveredColumn,
            deploys: board.deploys
                .filter { $0.at >= board.from && $0.at <= board.to }
                .map { (fraction(of: $0.at), $0.status == .failed) },
            marker: board.marker.map(fraction(of:))
        )
        .overlay {
            GeometryReader { geo in
                Rectangle()
                    .fill(.clear)
                    .contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case let .active(location):
                            // The centre of the column under the pointer, so every panel's
                            // value comes from that same bucket.
                            let c = min(columns - 1, max(0, Int(location.x / max(1, geo.size.width) * CGFloat(columns))))
                            hover = board.from.addingTimeInterval((Double(c) + 0.5) * step)
                        case .ended:
                            hover = nil
                        }
                    }
                    .onTapGesture(perform: onSelect)
            }
        }
    }
}

// MARK: Deploys

private struct DeployList: View {
    let deploys: [Board.Deploy]
    let limit: Int

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
                    Text(Format.relative(deploy.at))
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
            .bleedInset()
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
