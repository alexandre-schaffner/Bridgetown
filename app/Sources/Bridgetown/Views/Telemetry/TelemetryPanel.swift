import SwiftUI

/// The top of the overview: three numbers, then prod as Grafana sees it over the last
/// hour: incidents (API errors and latency, engine and job errors), infra (RPC, jobs,
/// memory kills, Postgres) or database (prod Postgres connections, lock waits, longest
/// transaction, replication lag), with deploys marked; or its logs, as the last sweep
/// grouped them, suspicious patterns first.
struct TelemetryPanel: View {
    @Environment(Store.self) private var store
    let snapshot: Snapshot
    let now: Date

    enum Mode: String, CaseIterable, Identifiable {
        case incidents = "Incidents"
        case infra = "Infra"
        case database = "Database"
        case logs = "Logs"
        var id: Self { self }
    }

    @AppStorage("telemetryMode") private var mode: Mode = .incidents

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Straight under the header's hairline, so only its own bottom one is drawn.
            VStack(spacing: 0) {
                StatStrip(snapshot: snapshot)
                Hairline()
            }
            VStack(alignment: .leading, spacing: 10) {
                header
                    .bleedInset()
                // One board crossfades into the next, rather than swapping in a frame.
                Group {
                    switch mode {
                    case .incidents: board("incidents")
                    case .infra: board("infra")
                    case .database: board("database")
                    case .logs: LogSweepView(now: now)
                    }
                }
                .id(mode)
                .transition(.opacity)
            }
            .animation(Easing.state, value: mode)
            .onHorizontalSwipe(swipedTab)
        }
        // Its numbers and charts run to the column's edges, like the lists beside it.
        .environment(\.fullBleed, true)
    }

    /// Fingers moving left show the next board, right the previous one; nothing past either end.
    private func swipedTab(_ direction: SwipeDirection) -> Bool {
        let all = Mode.allCases
        guard let index = all.firstIndex(of: mode) else { return false }
        let next = direction == .forward ? index + 1 : index - 1
        guard all.indices.contains(next) else { return false }
        Haptics.perform(.alignment, "telemetry.swipeTab")
        mode = all[next]
        return true
    }

    /// A board view of `GET /boards/:view`.
    private func board(_ view: String) -> some View {
        PollingLoader(key: view, fetch: { try await store.board(view: view) }) { loaded in
            if let board = loaded.value ?? nil {
                BoardView(board: board, rows: true)
            } else if let error = loaded.error {
                BoardMessage(symbol: "exclamationmark.triangle", text: "Couldn't load the \(view) board · \(error)")
            } else {
                BoardSkeleton()
            }
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            Text("Prod")
                .font(Typo.title)
                .tracking(Typo.titleTracking)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            TabSwitch(options: Mode.allCases, selection: $mode) { $0.rawValue }
        }
        .frame(height: SectionHeader.height)
    }
}

// MARK: Stat strip

/// Needs you · Agents · Resolved. The number itself takes the colour, only where it means something:
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
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(label)
                    .font(.geist(12, .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let tint {
                    LiveDot(color: tint, live: live, size: 7)
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(value)
                    .font(.geist(26).monospacedDigit())
                    .tracking(-0.5)
                    .foregroundStyle(tint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.primary))
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .fixedSize()
                Text(caption)
                    .font(.geist(12))
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.horizontal, Metrics.inset)
        .padding(.vertical, 15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .animation(.snappy(duration: 0.25), value: value)
    }
}
