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
    @ViewState private var picks = OverviewPicks()

    /// The prod column: what's wrong, if anything, then the prod board.
    static let prodWidth: CGFloat = 380
    /// The status line's inset from the band's left edge, and its gap before the wings.
    private static let bandInset: CGFloat = 16
    private static let wingGap: CGFloat = 8

    var body: some View {
        let geometry = model.geometry
        // Only schedules the redraw: the time itself is the app's clock.
        TimelineView(.periodic(from: .now, by: 30)) { _ in
            VStack(spacing: 0) {
                band(geometry)
                Hairline()
                HStack(alignment: .top, spacing: 0) {
                    status
                        .frame(width: Self.prodWidth)
                    Hairline(vertical: true)
                    main
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        .clipped()
                }
            }
            .environment(\.now, AppClock.now)
        }
        .frame(width: geometry.openWidth, height: geometry.notch.height + geometry.openHeight, alignment: .top)
        .stage()
    }

    private func band(_ geometry: NotchGeometry) -> some View {
        let notch = geometry.notch
        // The wings sit centred; the status line stops short of the left one.
        let beside = (geometry.openWidth - notch.width) / 2 - IslandModel.wing
        return ZStack {
            GlanceWings(glance: model.glance, notch: notch, hovering: false)
            HeaderView(room: beside - Self.bandInset - Self.wingGap)
                .padding(.leading, Self.bandInset)
                .padding(.trailing, 10)
        }
        .frame(height: notch.height)
    }

    private var status: some View {
        PaneScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ProblemList()
                // Before the first snapshot the main column says what's happening.
                if store.snapshot != nil {
                    TelemetryPanel()
                }
            }
            // Vertical only: the charts run to the column's edges.
            .padding(.vertical, Metrics.inset)
        }
        .accessibilityIdentifier("pane.status")
    }

    private var main: some View {
        RouteContent { overview }
            .animation(Easing.pane, value: store.route)
    }

    @ViewBuilder
    private var overview: some View {
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
                                NeedsYouSection(snapshot: snap, selection: $picks.needsYou)
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
                                AgentsSection(running: running, selection: $picks.agents)
                            }
                            RecentSection(snapshot: snap, selection: $picks.recent)
                        }
                        .padding(.vertical, Metrics.inset)
                    }
                    .accessibilityIdentifier("pane.agents")
                }
                .background {
                    // Escape clears what is picked, in every list at once. Draws nothing.
                    if !picks.isEmpty {
                        Button("Clear selection") { picks = OverviewPicks() }
                            .keyboardShortcut(.cancelAction)
                            .opacity(0)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
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
                .font(Typo.body)
                .foregroundStyle(.tertiary)
                .padding(.vertical, 4)
        }
        .padding(.horizontal, Metrics.inset)
    }
}
