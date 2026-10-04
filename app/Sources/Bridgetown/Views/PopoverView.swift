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
                    .padding(.leading, 16)
                    .padding(.trailing, 10)
                    .padding(.vertical, 8)
                Hairline()
                PaneScrollView {
                    content(now: context.date)
                        .padding(Metrics.inset)
                }
            }
        }
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        if let snap = store.snapshot {
            let running = snap.inFlightSessions
            VStack(alignment: .leading, spacing: 24) {
                ProblemList()
                if snap.isQuiet {
                    EmptyState(snapshot: snap)
                }
                if !snap.actions.isEmpty {
                    NeedsYouSection(snapshot: snap, now: now)
                }
                if !running.isEmpty {
                    AgentsSection(running: running, now: now)
                }
                TelemetryPanel(now: now)
                RecentSection(snapshot: snap, now: now)
            }
        } else {
            VStack(spacing: 0) {
                ProblemList()
                ConnectingState()
            }
        }
    }
}
