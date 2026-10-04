import Charts
import SwiftUI

/// A Grafana board as one outlined grid, two cells a row, hairlines between. Hovering one panel moves a shared
/// crosshair across all of them, as in Grafana, and each shows its value at that time.
/// Deploys are dashed rules (red when they failed), the alert that opened the board is an
/// orange rule. Clicking a panel opens its dashboard in Grafana.
struct BoardView: View {
    let board: Board
    var maxDeploys = 3

    @ViewState private var hover: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let error = board.error {
                BoardMessage(symbol: "chart.xyaxis.line", text: error)
            } else {
                CellGrid(items: board.panels) { MiniPanel(panel: $0, board: board, hover: $hover) }
            }
            if !board.deploys.isEmpty {
                DeployList(deploys: board.deploys, limit: maxDeploys)
            }
            footer
        }
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
        .font(.geist(10.5).monospacedDigit())
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

    @ViewState private var hovering = false

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

    /// The current series (the one still reporting) bright, the rest faint: for pods by
    /// version, the new tag reads as the live one.
    private func color(_ label: String) -> Color {
        guard panel.series.count > 1 else { return Color.white.opacity(0.85) }
        let latest = panel.series.first { $0.label == label }?.points.last?[1] ?? 0
        return latest > 0 ? Ink.mark : Color.white.opacity(0.25)
    }

    private var yMax: Double {
        let top = points.map(\.value).max() ?? 0
        return top > 0 ? top * 1.15 : 1
    }

    /// The value under the shared crosshair (summed across series, like `latest`), or the latest.
    private var shown: Double? {
        guard let hover else { return panel.latest }
        let t = hover.timeIntervalSince1970
        let nearest = panel.series.compactMap { s in s.points.min { abs($0[0] - t) < abs($1[0] - t) }?.last }
        return nearest.isEmpty ? nil : nearest.reduce(0, +)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(panel.title)
                    .font(.geist(10.5, .semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 2)
                Text(shown.map(panel.unit.format) ?? "–")
                    .font(Typo.figure(12.5))
                    .foregroundStyle(panel.error == nil ? .primary : .tertiary)
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .fixedSize()
            }
            if let error = panel.error {
                Text(error)
                    .font(.geist(10))
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, minHeight: 38, alignment: .topLeading)
                    .help(error)
            } else if points.isEmpty {
                Text("No data in this window")
                    .font(.geist(10))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, minHeight: 38, alignment: .center)
            } else {
                chart.frame(height: 38)
            }
        }
        .padding(10)
        .background(hovering ? Ink.hover : .clear)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { SystemActions.open(panel.link) }
        .help("\(panel.title) · open in Grafana")
        .animation(.easeOut(duration: 0.12), value: hovering)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(panel.title)
        .accessibilityValue(panel.latest.map(panel.unit.format) ?? "No data")
        .accessibilityAddTraits(.isLink)
    }

    private var chart: some View {
        let single = panel.series.count == 1
        return Chart {
            ForEach(points) { p in
                // One series: a soft fade under the line, so the shape reads at a glance.
                if single {
                    AreaMark(x: .value("Time", p.at), y: .value("Value", p.value))
                        .foregroundStyle(LinearGradient(colors: [Color.white.opacity(0.16), Color.white.opacity(0)], startPoint: .top, endPoint: .bottom))
                        .interpolationMethod(.monotone)
                }
                LineMark(x: .value("Time", p.at), y: .value("Value", p.value), series: .value("Series", p.series))
                    .foregroundStyle(color(p.series))
                    .lineStyle(StrokeStyle(lineWidth: 1.25, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.monotone)
            }
            // The latest point, where the value in the corner comes from.
            if single, hover == nil, let last = points.last {
                PointMark(x: .value("Time", last.at), y: .value("Value", last.value))
                    .symbolSize(16)
                    .foregroundStyle(Ink.text)
            }
            ForEach(board.deploys.filter { $0.at >= board.from && $0.at <= board.to }) { deploy in
                RuleMark(x: .value("Deploy", deploy.at))
                    .foregroundStyle(deploy.status == .failed ? Ink.red.opacity(0.8) : Color.white.opacity(0.3))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 2]))
            }
            if let marker = board.marker {
                RuleMark(x: .value("Alert", marker))
                    .foregroundStyle(Ink.amber)
                    .lineStyle(StrokeStyle(lineWidth: 1.25))
            }
            if let hover {
                RuleMark(x: .value("Hover", hover))
                    .foregroundStyle(Color.primary.opacity(0.35))
                    .lineStyle(StrokeStyle(lineWidth: 1))
            }
        }
        .chartXScale(domain: board.from...board.to)
        .chartYScale(domain: 0...yMax)
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .chartOverlay { proxy in
            GeometryReader { geo in
                Rectangle()
                    .fill(.clear)
                    .contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case let .active(location):
                            guard let frame = proxy.plotFrame else { return }
                            hover = proxy.value(atX: location.x - geo[frame].origin.x)
                        case .ended:
                            hover = nil
                        }
                    }
                    .onTapGesture { SystemActions.open(panel.link) }
            }
        }
    }
}

// MARK: Deploys

private struct DeployList: View {
    let deploys: [Board.Deploy]
    let limit: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(deploys.prefix(limit)) { deploy in
                HStack(spacing: 6) {
                    Image(systemName: deploy.status == .failed ? "xmark.octagon.fill" : "arrow.up.circle")
                        .font(.geist(10))
                        .foregroundStyle(deploy.status == .failed ? AnyShapeStyle(Ink.red) : AnyShapeStyle(.secondary))
                        .frame(width: 12)
                    Text("\(deploy.image) \(deploy.version)")
                        .font(.geist(11, .medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(deploy.status == .failed ? "failed at \(deploy.stage)" : "deployed · \(deploy.stage)")
                        .font(.geist(11))
                        .foregroundStyle(deploy.status == .failed ? AnyShapeStyle(Ink.red) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(Format.relative(deploy.at))
                        .font(.geist(10.5))
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
                .accessibilityElement(children: .combine)
            }
            if deploys.count > limit {
                Text("\(deploys.count - limit) more deploy\(deploys.count - limit == 1 ? "" : "s")")
                    .font(.geist(10.5))
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 18)
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
                VStack(alignment: .leading, spacing: 8) {
                    RoundedRectangle(cornerRadius: 2).fill(Ink.track).frame(width: 70, height: 7)
                    RoundedRectangle(cornerRadius: 3).fill(Ink.track.opacity(0.6)).frame(height: 32)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .modifier(Pulse(active: true))
            }
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Querying Grafana…")
            }
            .font(.geist(10))
            .foregroundStyle(.tertiary)
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
                .font(.geist(11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(10)
        .outlined()
    }
}

// MARK: Loading

/// Loads a board and keeps it fresh: refetched every minute while on screen (the daemon
/// answers from its cache, so this costs Grafana nothing). Reopening the popover keeps
/// the board it had; only a different key starts over. A failed refetch keeps the last
/// board.
struct BoardLoader<Content: View>: View {
    let key: String
    let fetch: () async throws -> Board?
    @ViewBuilder let content: (Loadable<Board?>) -> Content

    @ViewState private var board = Loadable<Board?>()
    @ViewState private var loadedKey: String?

    var body: some View {
        content(board)
            .task(id: key) {
                if loadedKey != key {
                    board = Loadable()
                    loadedKey = key
                }
                while !Task.isCancelled {
                    let next = await board.reloaded(fetch)
                    // Switching tabs cancels this task after the next one has reset the board:
                    // writing now would put this key's board (or error) under the other tab.
                    guard !Task.isCancelled else { return }
                    board = next
                    try? await Task.sleep(for: .seconds(60))
                }
            }
    }
}
