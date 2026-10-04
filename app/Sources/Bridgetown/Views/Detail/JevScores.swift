import SwiftUI

/// Jev's three probabilities as bars, neutral: they're numbers, not states. "Human on it"
/// argues against the other two, so it sits a step fainter.
struct JevScores: View {
    let jev: Jev

    var body: some View {
        VStack(spacing: 6) {
            VerdictBar(label: "Actionable", value: jev.actionable, tint: Ink.mark)
            VerdictBar(label: "Agent-resolvable", value: jev.agentResolvable, tint: Ink.mark)
            VerdictBar(label: "Human on it", value: jev.humanOnIt, tint: Color.white.opacity(0.3))
        }
    }
}
