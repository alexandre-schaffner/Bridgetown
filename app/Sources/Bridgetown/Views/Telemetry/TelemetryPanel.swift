import SwiftUI

/// The top of the overview: three numbers, then prod as Grafana sees it over the last
/// day: incidents (API errors and latency, engine and job errors) or infra (RPC, jobs,
/// memory kills, Postgres), with deploys marked.
struct TelemetryPanel: View {
    @Environment(Store.self) private var store
    let snapshot: Snapshot
    let now: Date

    enum Mode: String, CaseIterable, Identifiable {
        case incidents = "Incidents"
        case infra = "Infra"
        var id: Self { self }
        var view: String { rawValue.lowercased() }
    }

    @AppStorage("telemetryMode") private var mode: Mode = .incidents

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StatStrip(snapshot: snapshot)
                .padding(.horizontal, Metrics.inset)
                .padding(.vertical, 10)
            Divider().opacity(0.6)
            VStack(alignment: .leading, spacing: 8) {
                header
                BoardLoader(key: mode.view, fetch: { try await store.board(view: mode.view) }) { loaded in
                    if let board = loaded.value ?? nil {
                        BoardView(board: board)
                    } else if let error = loaded.error {
                        BoardMessage(symbol: "exclamationmark.triangle", text: "Couldn't load the \(mode.view) board · \(error)")
                    } else {
                        BoardSkeleton()
                    }
                }
            }
            .padding(Metrics.inset)
        }
        .panel()
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            Text("Prod")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Picker("Board", selection: $mode) {
                ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.mini)
            .fixedSize()
        }
    }
}

// MARK: Stat strip

/// Needs you · Agents · Resolved. Colour only where the number means something:
/// orange when you're needed, accent while an agent, CI or a deploy is moving (not
/// while everything waits on reviewers), green for verified fixes.
private struct StatStrip: View {
    let snapshot: Snapshot

    var body: some View {
        let active = snapshot.activeSessions
        let moving = active.contains { $0.holder?.isMoving == true }
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
                caption: active.isEmpty ? "None active" : Session.breakdown(active, limit: 1),
                tint: moving ? .accentColor : nil,
                live: moving
            )
            Stat(
                label: "Resolved",
                value: sessions.map { "\($0.resolved)" } ?? "–",
                caption: sessions.map { "of \($0.started) · 24h" } ?? "24h",
                tint: (sessions?.resolved ?? 0) > 0 ? .green : nil
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
