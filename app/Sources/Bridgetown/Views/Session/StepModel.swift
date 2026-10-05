import SwiftUI

// How each of a session's six steps is drawn, from the daemon's step states, its tone
// and who has the next move. Kept apart from the views so every state can be tested.

extension StepPill {
    /// How a step stands, which decides its pill.
    enum Kind: Hashable {
        case ahead, done, moving, held, you, failed, stopped, resolved, skipped

        /// Tinted, with a mark at its head: where the session is, or how it ended.
        var isMarked: Bool { ![.ahead, .done, .skipped].contains(self) }
    }

    /// How much of the row is spelled out, from the widest to the narrowest: a column too
    /// narrow for every name keeps only the name of the step in play, then none.
    enum Style {
        /// Every step a pill with its name.
        case named
        /// The marked step named; the others as small marks.
        case focused
        /// Marks only; names stay in the tooltip and for VoiceOver.
        case marks
    }
}

extension Session {
    /// Where the session is: the step in progress or the one that failed; the next step
    /// when it waits between two (ready to merge, approval to release); past the end once
    /// resolved; where it stopped otherwise.
    var markerIndex: Int {
        let frontier = steps.firstIndex { $0.state == .pending || $0.state == .unknown } ?? steps.count
        if let i = steps.firstIndex(where: { $0.state == .failed }) { return i }
        if holder != nil { return steps.firstIndex { $0.state == .current } ?? frontier }
        if tone == .success { return steps.count }
        return frontier
    }

    /// How each step's pill stands, for animating a change across the row.
    var pillKinds: [StepPill.Kind] { steps.indices.map(pillKind(at:)) }

    func pillKind(at index: Int) -> StepPill.Kind {
        let step = steps[index]
        let at = markerIndex
        if step.state == .failed { return tone == .failure ? .failed : .stopped }
        if index == at, let holder {
            if holder == .you || tone == .waiting { return .you }
            return holder.isMoving ? .moving : .held
        }
        if index == at, !isActive { return .stopped }
        if step.state == .skipped { return .skipped }
        if index < at || step.state == .done {
            // The outcome sits on the last step that happened: Deployed, or the CI before
            // "No deploy" when nothing needed releasing.
            return tone == .success && index == steps.lastIndex(where: { $0.state == .done }) ? .resolved : .done
        }
        return .ahead
    }

    /// A marked pill's colour: the session's while it's in play (amber on you), red where
    /// it failed, green once resolved, grey where it stopped.
    func pillTint(at index: Int) -> Color {
        switch pillKind(at: index) {
        case .moving, .held: tone.isQuiet ? Ink.neutral : tone.color
        case .you: Ink.amber
        case .failed: Ink.red
        case .resolved: Ink.green
        default: Ink.neutral
        }
    }

    /// "Diagnose done, Fix in progress, …": the steps as words, for tooltips and VoiceOver.
    var stepsDescription: String {
        steps.map { "\($0.label) \($0.state.describe(tone: tone))" }.joined(separator: ", ")
    }
}
