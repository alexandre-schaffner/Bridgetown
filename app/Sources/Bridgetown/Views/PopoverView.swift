import SwiftUI

/// Root of the menu bar window. Swaps between the overview and a pushed session or alert
/// detail (NavigationStack misbehaves inside MenuBarExtra).
struct PopoverView: View {
    @Environment(\.popoverHeight) private var height

    /// A plain swap, no slide: a MenuBarExtra window that hides mid-animation freezes the
    /// transition and leaves both panes half-offset and overlapping.
    var body: some View {
        RouteContent(motion: .none) { OverviewPane() }
            .frame(width: Metrics.width, height: height, alignment: .top)
            .stage()
            .clipped()
    }
}

private struct OverviewPane: View {
    @Environment(Store.self) private var store

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(spacing: 0) {
                HeaderView(now: context.date)
                Hairline()
                PaneScrollView {
                    // Bottom only: the stats sit straight under the header, and the
                    // sections' rows run to the pane's edges.
                    content(now: context.date)
                        .padding(.bottom, Metrics.inset)
                }
                Hairline()
                FooterView()
            }
        }
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        if let snap = store.snapshot {
            let running = snap.activeSessions
            VStack(alignment: .leading, spacing: 24) {
                TelemetryPanel(snapshot: snap, now: now)
                if snap.isQuiet {
                    EmptyState(snapshot: snap)
                        .padding(.horizontal, Metrics.inset)
                }
                if !snap.actions.isEmpty {
                    NeedsYouSection(snapshot: snap, now: now)
                }
                if !running.isEmpty {
                    AgentsSection(running: running, now: now)
                }
                if !snap.alerts.isEmpty {
                    RecentSection(snapshot: snap, now: now)
                }
            }
        } else {
            ConnectingState()
        }
    }
}
