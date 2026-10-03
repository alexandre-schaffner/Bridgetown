import SwiftUI

/// Jev's three probabilities as bars. The two that argue for an agent share the accent;
/// "human on it" argues against, so it stays neutral.
struct JevScores: View {
    let jev: Jev

    var body: some View {
        VStack(spacing: 6) {
            VerdictBar(label: "Actionable", value: jev.actionable, tint: .accentColor)
            VerdictBar(label: "Agent-resolvable", value: jev.agentResolvable, tint: .accentColor)
            VerdictBar(label: "Human on it", value: jev.humanOnIt, tint: .secondary)
        }
    }
}
