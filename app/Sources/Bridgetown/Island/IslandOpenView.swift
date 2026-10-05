import SwiftUI

/// The island open: the whole app laid out wide under the notch, in three columns you read
/// left to right. Status and prod; what needs you; what the agents are doing and what came
/// in. A session or alert opens in place of the last two, the status column staying put.
///
/// The notch's own band keeps the wings from the resting island, so opening reads as the
/// same object unfolding.
struct IslandOpenView: View {
    @Environment(Store.self) private var store
    let model: IslandModel

    /// The status column: the header, the stats and the prod board.
    static let statusWidth: CGFloat = 380

    var body: some View {
        let geometry = model.geometry
        VStack(spacing: 0) {
            band(notch: geometry.notch)
            Hairline()
            // Only schedules the redraw: the time itself is the app's clock.
            TimelineView(.periodic(from: .now, by: 30)) { _ in
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

    private func band(notch: CGSize) -> some View {
        ZStack {
            GlanceWings(glance: model.glance, notch: notch, hovering: false)
            HStack {
                Spacer(minLength: 0)
                FooterView()
            }
        }
        .frame(height: notch.height)
    }

    private func status(now: Date) -> some View {
        VStack(spacing: 0) {
            HeaderView(now: now)
            Hairline()
            PaneScrollView {
                Group {
                    if let snap = store.snapshot {
                        TelemetryPanel(snapshot: snap, now: now)
                    } else {
                        ConnectingState()
                    }
                }
                // Bottom only: the stats sit straight under the header, and they and the
                // charts run to the column's edges.
                .padding(.bottom, Metrics.inset)
            }
            .accessibilityIdentifier("pane.status")
        }
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
                            if !snap.alerts.isEmpty {
                                RecentSection(snapshot: snap, now: now)
                            }
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
