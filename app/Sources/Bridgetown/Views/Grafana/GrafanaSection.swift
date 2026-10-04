import SwiftUI

/// "Grafana · <board>" in an alert's or a session's detail: the panels the daemon picks for
/// what the alert is about (its API route, release image, chain or kind), around the time
/// it fired. Hidden when nothing in Grafana tracks it, such as a DM.
struct GrafanaSection: View {
    @Environment(Store.self) private var store
    let alertId: String

    var body: some View {
        PollingLoader(key: alertId, fetch: { try await store.alertBoard(alertId: alertId) }) { loaded in
            if let found = loaded.value {
                if let board = found {
                    DetailSection(title: "Grafana", detail: board.title) { BoardView(board: board, maxDeploys: 4) }
                }
            } else if let error = loaded.error {
                DetailSection(title: "Grafana") {
                    BoardMessage(symbol: "exclamationmark.triangle", text: "Couldn't load the charts · \(error)")
                }
            } else {
                DetailSection(title: "Grafana") { BoardSkeleton() }
            }
        }
    }
}
