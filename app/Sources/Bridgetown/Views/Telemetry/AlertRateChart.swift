import Charts
import SwiftUI

/// Alerts per hour over the last day, stacked by outcome. Hovering an hour highlights its
/// bar and writes its breakdown to `readout`.
struct AlertRateChart: View {
    let metrics: Telemetry
    @Binding var readout: String?

    @ViewState private var hovered: Date?

    private struct Segment: Identifiable {
        let at: Date
        let tone: Tone
        let count: Int
        var id: String { "\(at.timeIntervalSince1970)-\(tone.rawValue)" }
    }

    private var segments: [Segment] {
        metrics.alertsByHour.flatMap { bucket in
            Tone.chartOrder.compactMap { tone in
                let n = bucket.count(tone)
                return n > 0 ? Segment(at: bucket.at, tone: tone, count: n) : nil
            }
        }
    }

    /// At least 4 on the y axis, so a single alert doesn't fill the chart.
    private var yMax: Int { max(4, metrics.alertsByHour.map(\.total).max() ?? 0) }

    private var xDomain: ClosedRange<Date> {
        let start = metrics.since
        let end = metrics.alertsByHour.last.map { $0.at.addingTimeInterval(3600) } ?? start.addingTimeInterval(86_400)
        return start...end
    }

    var body: some View {
        Chart {
            ForEach(segments) { segment in
                BarMark(
                    x: .value("Hour", segment.at, unit: .hour),
                    y: .value("Alerts", segment.count),
                    width: .ratio(0.72)
                )
                .foregroundStyle(segment.tone.chartColor)
                .opacity(hovered == nil || hovered == segment.at ? 1 : 0.35)
            }
            if let hovered {
                RuleMark(x: .value("Hour", hovered.addingTimeInterval(1800)))
                    .foregroundStyle(Color.primary.opacity(0.12))
                    .lineStyle(StrokeStyle(lineWidth: 14))
                    .zIndex(-1)
            }
        }
        .chartXScale(domain: xDomain)
        .chartYScale(domain: 0...yMax)
        .chartXAxis {
            AxisMarks(values: .stride(by: .hour, count: 6)) { value in
                AxisTick(length: 3, stroke: StrokeStyle(lineWidth: 0.5))
                    .foregroundStyle(Color(nsColor: .separatorColor))
                AxisValueLabel {
                    if let date = value.as(Date.self) {
                        Text(date, format: Format.clock)
                            .font(.system(size: 9).monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 3]))
                    .foregroundStyle(Color(nsColor: .separatorColor))
                AxisValueLabel {
                    if let n = value.as(Int.self) {
                        Text("\(n)")
                            .font(.system(size: 9).monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
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
                            let x = point.x - geo[frame].origin.x
                            guard let date: Date = proxy.value(atX: x) else { return hover(nil) }
                            hover(metrics.alertsByHour.last { $0.at <= date })
                        case .ended:
                            hover(nil)
                        }
                    }
            }
        }
        .animation(.snappy(duration: 0.25), value: metrics.alertsByHour)
        .accessibilityLabel(accessibilityText)
    }

    private func hover(_ bucket: Telemetry.Bucket?) {
        guard hovered != bucket?.at else { return }
        hovered = bucket?.at
        readout = bucket.map(Self.describe)
    }

    /// "14:00 · 5 alerts · 1 agent, 4 other".
    static func describe(_ bucket: Telemetry.Bucket) -> String {
        let hour = bucket.at.formatted(Format.clock)
        guard bucket.total > 0 else { return "\(hour) · No alerts" }
        let parts = Tone.chartOrder.compactMap { tone -> String? in
            let n = bucket.count(tone)
            return n > 0 ? "\(n) \(tone.metricLabel.lowercased())" : nil
        }
        return "\(hour) · \(bucket.total) alert\(bucket.total == 1 ? "" : "s") · \(parts.joined(separator: ", "))"
    }

    private var accessibilityText: String {
        let totals = Tone.chartOrder.map { "\(metrics.alertCount($0)) \($0.metricLabel.lowercased())" }
        return "\(metrics.alertCount) alerts in the last 24 hours: \(totals.joined(separator: ", "))"
    }
}
