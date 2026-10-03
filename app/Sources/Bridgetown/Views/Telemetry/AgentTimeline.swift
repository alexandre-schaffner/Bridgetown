import Charts
import SwiftUI

/// Every session of the last day as a bar from start to finish (or to now while it's
/// active), coloured by its tone. Hover names the session; click opens it.
struct AgentTimeline: View {
    struct Lane: Identifiable, Equatable {
        let id: String
        let title: String
        let headline: String
        let tone: Tone
        let start: Date
        let end: Date
        let active: Bool
    }

    let lanes: [Lane]
    let now: Date
    @Binding var readout: String?
    let open: (String) -> Void

    @ViewState private var hovered: String?

    /// Lanes fit the chart's height; past this the oldest finished sessions drop off.
    static let maxLanes = 12
    private static let window: TimeInterval = 24 * 3600

    /// Sessions that ran in the last day, oldest start at the top. Active ones are kept
    /// first when there are too many to show.
    static func lanes(_ sessions: [Session], now: Date) -> [Lane] {
        let cutoff = now.addingTimeInterval(-window)
        let recent = sessions.filter { $0.isActive || $0.updatedAt >= cutoff }
        let kept = recent.filter(\.isActive) + recent.filter { !$0.isActive }.sorted { $0.updatedAt > $1.updatedAt }
        return kept.prefix(maxLanes)
            .map { s in
                Lane(
                    id: s.id, title: s.title, headline: s.headline, tone: s.tone,
                    start: max(s.startedAt, cutoff),
                    end: s.isActive ? now : max(s.updatedAt, s.startedAt.addingTimeInterval(60)),
                    active: s.isActive
                )
            }
            .sorted { $0.start < $1.start }
    }

    /// The chart starts at the earliest lane, rounded down to the hour, and spans at least an hour.
    static func start(_ lanes: [Lane], now: Date) -> Date {
        let earliest = lanes.map(\.start).min() ?? now
        let floor = Calendar.current.dateInterval(of: .hour, for: earliest)?.start ?? earliest
        return min(floor, now.addingTimeInterval(-3600))
    }

    /// "last 6h".
    static func spanLabel(_ lanes: [Lane], now: Date) -> String {
        let hours = Int((now.timeIntervalSince(start(lanes, now: now)) / 3600).rounded(.up))
        return "last \(max(1, hours))h"
    }

    var body: some View {
        let start = Self.start(lanes, now: now)
        let span = now.timeIntervalSince(start)
        // Short sessions stay visible: every bar is at least 1.5% of the chart wide.
        let minWidth = span * 0.015
        let hours = max(1, Int((span / 3600).rounded(.up)))
        Chart(lanes) { lane in
            BarMark(
                xStart: .value("Start", lane.start),
                xEnd: .value("End", max(lane.end, lane.start.addingTimeInterval(minWidth))),
                y: .value("Session", lane.id),
                height: .fixed(lanes.count > 8 ? 4 : 6)
            )
            .foregroundStyle(lane.tone.chartColor)
            .clipShape(Capsule())
            .opacity(hovered == nil || hovered == lane.id ? 1 : 0.35)
        }
        .chartXScale(domain: start...now)
        .chartXAxis {
            AxisMarks(values: .stride(by: .hour, count: max(1, hours / 4))) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 3]))
                    .foregroundStyle(Color(nsColor: .separatorColor))
                AxisValueLabel(collisionResolution: .greedy(minimumSpacing: 4)) {
                    if let date = value.as(Date.self), now.timeIntervalSince(date) > span * 0.08 {
                        Text(date, format: Format.clock)
                            .font(.system(size: 9).monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .chartOverlay { proxy in
            GeometryReader { geo in
                Rectangle()
                    .fill(.clear)
                    .contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case let .active(point):
                            guard let frame = proxy.plotFrame else { return }
                            let y = point.y - geo[frame].origin.y
                            hover(nearestLane(atY: y, proxy: proxy))
                        case .ended:
                            hover(nil)
                        }
                    }
                    .onTapGesture {
                        if let hovered { open(hovered) }
                    }
            }
        }
        .animation(.snappy(duration: 0.25), value: lanes)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(lanes.count) agent sessions in the last day")
        .accessibilityValue(lanes.map { "\($0.title), \($0.headline)" }.joined(separator: "; "))
    }

    /// The lane whose row is closest to the pointer, so the thin bars are easy to hit.
    private func nearestLane(atY y: CGFloat, proxy: ChartProxy) -> Lane? {
        lanes
            .compactMap { lane in proxy.position(forY: lane.id).map { (lane, abs($0 - y)) } }
            .min { $0.1 < $1.1 }
            .flatMap { $0.1 < 10 ? $0.0 : nil }
    }

    private func hover(_ lane: Lane?) {
        guard hovered != lane?.id else { return }
        hovered = lane?.id
        readout = lane.map { lane in
            let duration = Format.duration(from: lane.start, to: lane.end)
            return "\(lane.title) · \(lane.active ? duration : lane.headline)"
        }
    }
}
