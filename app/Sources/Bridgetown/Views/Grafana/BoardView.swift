import Charts
import SwiftUI

/// A Grafana board in two columns of small panels. Hovering one panel moves a shared
/// crosshair across all of them, as in Grafana, and each shows its value at that time.
/// Deploys are dashed rules (red when they failed), the alert that opened the board is an
/// orange rule. Clicking a panel opens its dashboard in Grafana.
struct BoardView: View {
    let board: Board
    var maxDeploys = 3

    @ViewState private var hover: Date?

    private let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let error = board.error {
                BoardMessage(symbol: "chart.xyaxis.line", text: error)
            } else {
                LazyVGrid(columns: columns, spacing: 8) {
                    ForEach(board.panels) { MiniPanel(panel: $0, board: board, hover: $hover) }
                }
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
        .font(.system(size: 10))
        .monospacedDigit()
        .foregroundStyle(.tertiary)
        .lineLimit(1)
    }

    /// "Last 24h", or "03:00 – 12:00" around an alert.
    private var window: String {
        let span = board.to.timeIntervalSince(board.from)
        if board.marker == nil, abs(board.to.timeIntervalSinceNow) < 600 {
            return "Last \(Int((span / 3600).rounded()))h"
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

    /// The current series (the one still reporting) in accent, the rest gray: for pods by
    /// version, the new tag reads as the live one.
    private func color(_ label: String) -> Color {
        guard panel.series.count > 1 else { return .accentColor }
        let latest = panel.series.first { $0.label == label }?.points.last?[1] ?? 0
        return latest > 0 ? .accentColor : .secondary
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
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 2)
                Text(shown.map(panel.unit.format) ?? "–")
                    .font(.system(size: 12, weight: .semibold).monospacedDigit())
                    .foregroundStyle(panel.error == nil ? .primary : .tertiary)
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .fixedSize()
            }
            if let error = panel.error {
                Text(error)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, minHeight: 38, alignment: .topLeading)
                    .help(error)
            } else if points.isEmpty {
                Text("No data in this window")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, minHeight: 38, alignment: .center)
            } else {
                chart.frame(height: 38)
            }
        }
        .padding(8)
        .background(.quaternary.opacity(hovering ? 0.65 : 0.4), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
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
                if single {
                    AreaMark(x: .value("Time", p.at), y: .value("Value", p.value))
                        .foregroundStyle(Color.accentColor.opacity(0.14))
                        .interpolationMethod(.monotone)
                }
                LineMark(x: .value("Time", p.at), y: .value("Value", p.value), series: .value("Series", p.series))
                    .foregroundStyle(color(p.series))
                    .lineStyle(StrokeStyle(lineWidth: 1.25, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.monotone)
            }
            ForEach(board.deploys.filter { $0.at >= board.from && $0.at <= board.to }) { deploy in
                RuleMark(x: .value("Deploy", deploy.at))
                    .foregroundStyle(deploy.status == .failed ? Color.red.opacity(0.8) : Color.secondary.opacity(0.55))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 2]))
            }
            if let marker = board.marker {
                RuleMark(x: .value("Alert", marker))
                    .foregroundStyle(Color.orange)
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
                        .font(.system(size: 10))
                        .foregroundStyle(deploy.status == .failed ? AnyShapeStyle(Color.red) : AnyShapeStyle(.secondary))
                        .frame(width: 12)
                    Text("\(deploy.image) \(deploy.version)")
                        .font(.system(size: 11, weight: .medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(deploy.status == .failed ? "failed at \(deploy.stage)" : "deployed · \(deploy.stage)")
                        .font(.system(size: 11))
                        .foregroundStyle(deploy.status == .failed ? AnyShapeStyle(Color.red) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(Format.relative(deploy.at))
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
                .accessibilityElement(children: .combine)
            }
            if deploys.count > limit {
                Text("\(deploys.count - limit) more deploy\(deploys.count - limit == 1 ? "" : "s")")
                    .font(.system(size: 10.5))
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
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(0..<count, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 2).fill(.quaternary).frame(width: 70, height: 7)
                        RoundedRectangle(cornerRadius: 3).fill(.quaternary.opacity(0.6)).frame(height: 32)
                    }
                    .padding(8)
                    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .modifier(Pulse(active: true))
                }
            }
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Querying Grafana…")
            }
            .font(.system(size: 10))
            .foregroundStyle(.tertiary)
        }
        .accessibilityLabel("Loading Grafana charts")
    }
}

struct BoardMessage: View {
    let symbol: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Text(text)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
    }
}

// MARK: Loading

/// Loads a board and keeps it fresh: refetched every minute while on screen (the daemon
/// answers from its cache, so this costs Grafana nothing). A failed refetch keeps the
/// last board.
struct BoardLoader<Content: View>: View {
    let key: String
    let fetch: () async throws -> Board?
    @ViewBuilder let content: (Loadable<Board?>) -> Content

    @ViewState private var board = Loadable<Board?>()

    var body: some View {
        content(board)
            .task(id: key) {
                board = Loadable()
                while !Task.isCancelled {
                    board = await board.reloaded(fetch)
                    try? await Task.sleep(for: .seconds(60))
                }
            }
    }
}
