import SwiftUI

/// The top of the overview: three numbers, then prod as Grafana sees it over the last
/// hour: incidents (API errors and latency, engine and job errors), infra (RPC, jobs,
/// memory kills, Postgres) or database (prod Postgres connections, lock waits, longest
/// transaction, replication lag), with deploys marked.
struct TelemetryPanel: View {
    @Environment(Store.self) private var store
    let snapshot: Snapshot
    let now: Date

    enum Mode: String, CaseIterable, Identifiable {
        case incidents = "Incidents"
        case infra = "Infra"
        case database = "Database"
        var id: Self { self }
        var view: String { rawValue.lowercased() }
    }

    @AppStorage("telemetryMode") private var mode: Mode = .incidents

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            StatStrip(snapshot: snapshot)
                .outlined()
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
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            Text("Prod")
                .font(Typo.title)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            TabSwitch(options: Mode.allCases, selection: $mode) { $0.rawValue }
        }
        .frame(height: 20)
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
                tint: snapshot.actions.isEmpty ? nil : Ink.amber
            )
            Hairline(vertical: true)
            Stat(
                label: "Agents",
                value: "\(active.count)",
                caption: active.isEmpty ? "None active" : Session.breakdown(active, limit: 1),
                tint: moving ? Ink.blue : nil,
                live: moving
            )
            Hairline(vertical: true)
            Stat(
                label: "Resolved",
                value: sessions.map { "\($0.resolved)" } ?? "–",
                caption: sessions.map { "of \($0.started) · 24h" } ?? "24h",
                tint: (sessions?.resolved ?? 0) > 0 ? Ink.green : nil
            )
        }
        .fixedSize(horizontal: false, vertical: true)
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
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                SectionLabel(label)
                Spacer(minLength: 0)
                if let tint {
                    LiveDot(color: tint, live: live)
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(value)
                    .font(.geist(22).monospacedDigit())
                    .tracking(-0.4)
                    .foregroundStyle(.primary)
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .fixedSize()
                Text(caption)
                    .font(.geist(11))
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .animation(.snappy(duration: 0.25), value: value)
    }
}
