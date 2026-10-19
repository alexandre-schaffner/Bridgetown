import SwiftUI
import ThinkingOrbs

// Marks for live work: drawn from the clock rather than animated, so nothing they do
// can drag a row's layout along. They hold still under Reduce Motion, out of sight, and
// over the last update while the daemon is away.

private struct OutOfSightKey: EnvironmentKey {
    static let defaultValue = false
}

private struct ShowsLastUpdateKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Kept in the hierarchy but not on screen, so it keeps its state: the overview under
    /// a detail (`RouteContent`).
    var outOfSight: Bool {
        get { self[OutOfSightKey.self] }
        set { self[OutOfSightKey.self] = newValue }
    }

    /// What shows is the last snapshot, kept through a lost connection (`IslandOpenView`):
    /// the agents run in the daemon, so nothing on it is known to be moving now.
    var showsLastUpdate: Bool {
        get { self[ShowsLastUpdateKey.self] }
        set { self[ShowsLastUpdateKey.self] = newValue }
    }

    /// Marks drawn from the clock hold still: under Reduce Motion; out of sight, where
    /// every frame they drew would be thrown away; and over the last update, where motion
    /// would claim work that nobody can see happening.
    var marksHoldStill: Bool { accessibilityReduceMotion || outOfSight || showsLastUpdate }
}

// MARK: Live

/// A status dot with a 1pt halo of its colour, like the step bars; live, it breathes.
struct LiveDot: View {
    let color: Color
    var live = false
    var size: CGFloat = 6

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .shadow(color: color.opacity(0.5), radius: 1)
            .modifier(Pulse(active: live))
    }
}

// MARK: Pulse

/// Gentle opacity pulse for "in progress".
///
/// Opacity is computed from the clock on every frame instead of animated. Any SwiftUI
/// animation here (`withAnimation(.repeatForever)`, `phaseAnimator`) opens a transaction
/// that also captures layout changes in the row, such as new activity text or the list
/// reflowing, and the bars then slide out of place. A pure function of time cannot move
/// anything.
struct Pulse: ViewModifier {
    var active: Bool
    @Environment(\.marksHoldStill) private var still

    private static let period: Double = 2.2

    func body(content: Content) -> some View {
        if active && !still {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.period) / Self.period
                content.opacity(0.7 + 0.3 * cos(phase * 2 * .pi))
            }
        } else {
            content
        }
    }
}

// MARK: Agent status

/// The agent status headline’s thinking orb (Libraries.dev's thinking-orbs) whose figure
/// says what kind of work it is, searching through a diagnosis, composing a fix, solving a
/// review, in the step's colour. Drawn from the clock, like `Pulse`, so it can't drag the
/// row's layout along. Held still, it is one frame of the same figure.
struct AgentOrb: View {
    let step: Step.Key
    let color: Color
    var size: CGFloat = 32
    @Environment(\.marksHoldStill) private var still

    var body: some View {
        ThinkingOrb(state: Self.state(step), size: .px64, theme: .dark, paused: still, displaySize: size, tint: color)
            .accessibilityHidden(true)
    }

    static func state(_ step: Step.Key) -> OrbState {
        switch step {
        case .diagnose: .searching
        case .fix: .composing
        case .pr: .weaving
        case .critique: .solving
        case .ci: .working
        case .deploy: .connecting
        case .unknown: .breathing
        }
    }
}
