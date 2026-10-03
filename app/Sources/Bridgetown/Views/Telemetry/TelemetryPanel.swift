import SwiftUI

/// The top of the overview: four numbers, then a chart of the last day. Alerts by hour
/// and outcome, or each agent session on a timeline. Hovering a chart replaces the
/// panel title with a readout of what's under the pointer.
struct TelemetryPanel: View {
    @Environment(Store.self) private var store
    let snapshot: Snapshot
    let now: Date

    enum Mode: String, CaseIterable, Identifiable {
        case alerts = "Alerts"
        case agents = "Agents"
        var id: Self { self }
    }

    @AppStorage("telemetryMode") private var mode: Mode = .alerts
    @ViewState private var readout: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StatStrip(snapshot: snapshot)
                .padding(.horizontal, Metrics.inset)
                .padding(.vertical, 10)
            Divider().opacity(0.6)
            VStack(alignment: .leading, spacing: 8) {
                header
                chart
                    .frame(height: 76)
                if mode == .alerts, let metrics = snapshot.metrics {
                    AlertLegend(metrics: metrics)
                }
            }
            .padding(Metrics.inset)
        }
        .panel()
        .onChange(of: mode) { readout = nil }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(readout ?? title)
                .font(.system(size: 11, weight: readout == nil ? .semibold : .medium))
                .monospacedDigit()
                .foregroundStyle(readout == nil ? .secondary : .primary)
                .lineLimit(1)
                .truncationMode(.tail)
                .contentTransition(.identity)
            Spacer(minLength: 0)
            Picker("Chart", selection: $mode) {
                ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.mini)
            .fixedSize()
        }
    }

    private var title: String {
        switch mode {
        case .alerts:
            guard let metrics = snapshot.metrics else { return "Alerts" }
            let n = metrics.alertCount
            return "\(n) alert\(n == 1 ? "" : "s") · 24h"
        case .agents:
            let lanes = AgentTimeline.lanes(snapshot.sessions, now: now)
            return lanes.isEmpty ? "Agents" : "\(lanes.count) session\(lanes.count == 1 ? "" : "s") · \(AgentTimeline.spanLabel(lanes, now: now))"
        }
    }

    @ViewBuilder
    private var chart: some View {
        switch mode {
        case .alerts:
            if let metrics = snapshot.metrics {
                AlertRateChart(metrics: metrics, readout: $readout)
            } else {
                ChartPlaceholder(text: "This daemon doesn't report metrics yet. Update it to see the last 24 hours.")
            }
        case .agents:
            let lanes = AgentTimeline.lanes(snapshot.sessions, now: now)
            if lanes.isEmpty {
                ChartPlaceholder(text: "No agent has run in the last 24 hours.")
            } else {
                AgentTimeline(lanes: lanes, now: now, readout: $readout) { store.show(.session($0)) }
            }
        }
    }
}

// MARK: Stat strip

/// Needs you · Agents · Resolved · Spend. Colour only where the number means something:
/// orange when you're needed, accent while agents work, green for verified fixes.
private struct StatStrip: View {
    let snapshot: Snapshot

    var body: some View {
        let active = snapshot.activeSessions
        let working = active.filter { $0.tone == .live }.count
        let sessions = snapshot.metrics?.sessions
        HStack(alignment: .top, spacing: 0) {
            Stat(
                label: "Needs you",
                value: "\(snapshot.actions.count)",
                caption: snapshot.actions.isEmpty ? "Nothing waiting" : waitingCaption,
                tint: snapshot.actions.isEmpty ? nil : .orange
            )
            Stat(
                label: "Agents",
                value: "\(active.count)",
                caption: active.isEmpty ? "None active" : "\(working) working",
                tint: working > 0 ? .accentColor : nil,
                live: working > 0
            )
            Stat(
                label: "Resolved",
                value: sessions.map { "\($0.resolved)" } ?? "–",
                caption: sessions.map { "of \($0.started) · 24h" } ?? "24h",
                tint: (sessions?.resolved ?? 0) > 0 ? .green : nil
            )
            Stat(
                label: "Spend",
                value: sessions.map { Format.cost($0.costUsd) } ?? "–",
                caption: "agents · 24h",
                tint: nil
            )
        }
    }

    /// The oldest card's age: how long something has been waiting on you.
    private var waitingCaption: String {
        guard let oldest = snapshot.actions.map(\.createdAt).min() else { return "" }
        return "oldest \(Format.relative(oldest))"
    }
}

private struct Stat: View {
    let label: String
    let value: String
    let caption: String
    let tint: Color?
    var live = false

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Text(label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
                if live {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 5, height: 5)
                        .modifier(Pulse(active: true))
                }
            }
            Text(value)
                .font(.system(size: 18, weight: .semibold).monospacedDigit())
                .foregroundStyle(tint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.primary))
                .contentTransition(.numericText())
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(caption)
                .font(.system(size: 10))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .animation(.snappy(duration: 0.25), value: value)
    }
}

// MARK: Legend

private struct AlertLegend: View {
    let metrics: Telemetry

    var body: some View {
        HStack(spacing: 9) {
            ForEach(Tone.chartOrder, id: \.self) { tone in
                let n = metrics.alertCount(tone)
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                        .fill(tone.chartColor)
                        .frame(width: 6, height: 6)
                    Text(tone.metricLabel)
                        .foregroundStyle(.secondary)
                    Text(n, format: .number)
                        .monospacedDigit()
                        .foregroundStyle(n == 0 ? .tertiary : .primary)
                }
                .fixedSize()
                .opacity(n == 0 ? 0.6 : 1)
                .help(tone.metricHelp)
                .accessibilityElement(children: .combine)
            }
            Spacer(minLength: 0)
        }
        .font(.system(size: 10, weight: .medium))
        .lineLimit(1)
    }
}

private struct ChartPlaceholder: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 16)
    }
}
