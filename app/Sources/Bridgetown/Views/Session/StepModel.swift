import SwiftUI

// How who has a session's next move (the daemon's `holder`), its step states and its tone
// draw its dot and each of its six steps. Kept apart from the views so every state can be
// tested.

// MARK: Who has the next move

extension Session.Holder {
    var label: String {
        switch self {
        case .agent: "working"
        case .critic: "in adversarial review"
        case .you: "on you"
        case .reviewers: "in review"
        case .ci: "on CI"
        case .deploy: "deploying"
        case .queue: "queued"
        case .unknown: "in progress"
        }
    }

    /// Something is progressing with no person involved: the agent, the adversarial review, CI or a deploy.
    var isMoving: Bool { self == .agent || self == .critic || self == .ci || self == .deploy }
}

extension Session {
    /// How the session's dot is drawn, in its tone's colour, the same on its row and in its
    /// detail. Only motion pulses: the daemon's tone calls "In review" live, yet nobody
    /// is working on it.
    enum Dot: Equatable {
        /// Something moves it (the agent, the adversarial review, CI, a deploy): it pulses.
        case moving
        /// A ring: it waits on someone else (reviewers, the queue).
        case waiting
        /// Filled and still: it is on you, or it has ended.
        case still
    }

    var dot: Dot {
        switch holder {
        case let holder? where holder.isMoving: .moving
        case .you?, nil: .still
        case _?: .waiting
        }
    }
}

// MARK: Steps

extension Step.State {
    /// For tooltips and VoiceOver. A stopped step is "failed" only when the session's
    /// tone says so; a closed or stopped session merely stopped there.
    func describe(tone: Tone) -> String {
        switch self {
        case .done: "done"
        case .current: tone == .waiting ? "waiting on you" : "in progress"
        case .pending: "not reached"
        case .failed: tone == .failure ? "failed here" : "stopped here"
        case .skipped: "not needed"
        case .unknown: "unknown"
        }
    }
}

extension Tone {
    /// Where a session stopped: red only when the daemon calls it a failure; a closed or
    /// stopped session is gray.
    var stopTint: Color { self == .failure ? Ink.red : .secondary }

    var stopSymbol: String { self == .failure ? "xmark.circle" : "minus.circle" }
}

// MARK: Step appearance

extension Session {
    /// How a step stands, independently of its visual treatment.
    enum StepKind: Hashable {
        case ahead, done, moving, held, you, failed, stopped, resolved, skipped

        /// Where the session is, or how it ended.
        var isMarked: Bool { ![.ahead, .done, .skipped].contains(self) }
    }

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

    /// How each step stands, for drawing and updating its progress segment.
    var stepKinds: [StepKind] { steps.indices.map(stepKind(at:)) }

    /// The counter names the step in play, or the last outcome, never a count of successes.
    var focusedStepIndex: Int? { steps.indices.first { stepKind(at: $0).isMarked } }

    var focusedStepDescription: String {
        guard let index = focusedStepIndex else { return stepsDescription }
        return "Step \(index + 1) of \(steps.count), \(steps[index].label), \(stepStatus(at: index))"
    }

    func stepStatus(at index: Int) -> String {
        if steps[index].state == .unknown { return "Unknown" }
        return switch stepKind(at: index) {
        case .ahead: "Not reached"
        case .done, .resolved: "Done"
        case .moving: "In progress"
        case .held: holder == .queue ? "Queued" : steps[index].state == .current ? "In progress" : "Waiting"
        case .you: "Waiting on you"
        case .failed: "Failed"
        case .stopped: "Stopped"
        case .skipped: "Not needed"
        }
    }

    func stepKind(at index: Int) -> StepKind {
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

    /// A marked step's colour: the session's while it's in play (amber on you), red where
    /// it failed, green once resolved, grey where it stopped.
    func stepTint(at index: Int) -> Color {
        switch stepKind(at: index) {
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
