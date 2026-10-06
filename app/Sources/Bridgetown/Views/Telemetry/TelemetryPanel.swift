import SwiftUI

/// Prod as Grafana sees it over the last hour: incidents (API errors and latency, engine
/// and job errors), infra (RPC, jobs, memory kills, Postgres) or database (prod Postgres
/// connections, lock waits, longest transaction, replication lag), with deploys marked; or
/// its logs, as the last sweep grouped them, suspicious patterns first.
struct TelemetryPanel: View {
    @Environment(Store.self) private var store

    enum Mode: String, CaseIterable, Identifiable {
        case incidents = "Incidents"
        case infra = "Infra"
        case database = "Database"
        case logs = "Logs"
        var id: Self { self }
    }

    @AppStorage("telemetryMode") private var mode: Mode = .incidents

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
                .padding(.horizontal, Metrics.inset)
            // One board crossfades into the next, rather than swapping in a frame.
            Group {
                switch mode {
                case .incidents: board("incidents")
                case .infra: board("infra")
                case .database: board("database")
                case .logs: LogSweepView()
                }
            }
            .id(mode)
            .transition(.opacity)
        }
        .animation(Easing.state, value: mode)
        .onHorizontalSwipe(swipedTab)
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
        SectionHeader(title: "Prod") {
            TabSwitch(options: Mode.allCases, selection: $mode) { $0.rawValue }
        }
    }
}
