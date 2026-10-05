import SwiftUI

/// The island open: the whole app laid out wide under the notch, in three columns you read
/// left to right. Prod; what needs you; what the agents are doing and what came in. A
/// session or alert opens in place of the last two, the prod column staying put.
///
/// The notch's own band keeps the wings from the resting island, so opening reads as the
/// same object unfolding. Beside them, the app's status line and its menu.
struct IslandOpenView: View {
    @Environment(Store.self) private var store
    let model: IslandModel

    /// The prod column: what's wrong, if anything, then the prod board.
    static let statusWidth: CGFloat = 380

    var body: some View {
        let geometry = model.geometry
        // Only schedules the redraw: the time itself is the app's clock.
        TimelineView(.periodic(from: .now, by: 30)) { _ in
            VStack(spacing: 0) {
                band(notch: geometry.notch, now: AppClock.now)
                Hairline()
                HStack(alignment: .top, spacing: 0) {
                    status(now: AppClock.now)
                        .frame(width: Self.statusWidth)
                    Hairline(vertical: true)
                    main(now: AppClock.now)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        .clipped()
                }
            }
        }
        .frame(width: geometry.openWidth, height: geometry.notch.height + geometry.openHeight, alignment: .top)
        .stage()
    }

    private func band(notch: CGSize, now: Date) -> some View {
        ZStack {
            GlanceWings(glance: model.glance, notch: notch, hovering: false)
            HeaderView(now: now)
                .padding(.leading, 16)
                .padding(.trailing, 10)
        }
        .frame(height: notch.height)
    }

    private func status(now: Date) -> some View {
        PaneScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ProblemList()
                // Before the first snapshot the main column says what's happening.
                if store.snapshot != nil {
                    TelemetryPanel(now: now)
                }
            }
            // Vertical only: the charts run to the column's edges.
            .padding(.vertical, Metrics.inset)
        }
        .accessibilityIdentifier("pane.status")
    }

    private func main(now: Date) -> some View {
        RouteContent { overview(now: now) }
            .animation(.smooth(duration: 0.32), value: store.route)
    }

    @ViewBuilder
    private func overview(now: Date) -> some View {
        if let snap = store.snapshot {
            let running = snap.inFlightSessions
            if snap.isQuiet {
                EmptyState(snapshot: snap)
                    .frame(maxHeight: .infinity)
            } else {
                HStack(alignment: .top, spacing: 0) {
                    PaneScrollView {
                        Group {
                            if snap.actions.isEmpty {
                                ColumnNote(title: "Needs you", text: "Nothing is waiting on you.")
                            } else {
                                NeedsYouSection(snapshot: snap, now: now)
                            }
                        }
                        // Vertical only: the sections' rows run to the column's edges.
                        .padding(.vertical, Metrics.inset)
                    }
                    .accessibilityIdentifier("pane.needsYou")
                    Hairline(vertical: true)
                    PaneScrollView {
                        VStack(alignment: .leading, spacing: 24) {
                            if running.isEmpty {
                                ColumnNote(
                                    title: "Agents",
                                    text: snap.activeSessions.isEmpty ? "No agent is running." : "Every open session is waiting on you."
                                )
                            } else {
                                AgentsSection(running: running, now: now)
                            }
                            RecentSection(snapshot: snap, now: now)
                        }
                        .padding(.vertical, Metrics.inset)
                    }
                    .accessibilityIdentifier("pane.agents")
                }
            }
        } else {
            ConnectingState()
                .frame(maxHeight: .infinity)
        }
    }
}

/// A column's title over a quiet line, when it has nothing to list.
private struct ColumnNote: View {
    let title: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: title)
            Text(text)
                .font(.geist(12))
                .foregroundStyle(.tertiary)
                .padding(.vertical, 4)
        }
        .padding(.horizontal, Metrics.inset)
    }
}
