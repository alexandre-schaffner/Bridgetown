import Testing
@testable import Bridgetown

/// How each step's pill stands (`Session.pillKind`), for the states the daemon sends.
@Suite struct StepModelTests {
    private typealias Kind = StepPill.Kind

    /// A session of `status`, `tone` and `holder` whose steps are `states` in order,
    /// labelled as the daemon labels them.
    private func session(
        _ status: Session.State, _ tone: Tone, _ holder: Session.Holder?, _ states: [Step.State], labels: [String]? = nil
    ) throws -> Session {
        var s = try #require(Fixture.snapshot().session(id: "ses_running"))
        let keys: [Step.Key] = [.diagnose, .fix, .pr, .critique, .ci, .deploy]
        let names = labels ?? ["Diagnose", "Fix", "PR", "Review", "CI", "Deploy"]
        s.status = status
        s.tone = tone
        s.holder = holder
        s.reviewChannel = nil
        s.steps = zip(keys, zip(names, states)).map { Step(key: $0, label: $1.0, state: $1.1) }
        return s
    }

    @Test func resolvedWithADeployIsGreenOnDeploy() throws {
        let s = try session(.resolved, .success, nil, [.done, .done, .done, .done, .done, .done],
                            labels: ["Diagnose", "Fix", "PR", "Review", "CI", "Deployed"])
        #expect(s.pillKinds == [.done, .done, .done, .done, .done, .resolved])
        #expect(s.pillTint(at: 5) == Ink.green)
    }

    /// Nothing to release: the daemon skips Deploy, and the outcome sits on CI.
    @Test func resolvedWithNoDeployIsGreenOnTheLastStepItReached() throws {
        let s = try session(.resolved, .success, nil, [.done, .done, .done, .done, .done, .skipped],
                            labels: ["Diagnose", "Fix", "PR", "Review", "CI", "No deploy"])
        #expect(s.pillKinds == [.done, .done, .done, .done, .resolved, .skipped])
        #expect(s.pillTint(at: 4) == Ink.green)
    }

    @Test func closedStopsGreyWhereItStopped() throws {
        let s = try session(.closed, .neutral, nil, [.failed, .pending, .pending, .pending, .pending, .skipped],
                            labels: ["Root cause?", "Fix", "No PR", "Review", "CI", "Deploy"])
        #expect(s.pillKind(at: 0) == .stopped)
        #expect(s.pillTint(at: 0) == Ink.neutral)
        #expect(!s.pillKinds.contains(.resolved))
    }

    @Test func failedIsRedWhereItFailed() throws {
        let s = try session(.failed, .failure, nil, [.done, .done, .failed, .pending, .pending, .pending])
        #expect(s.pillKinds == [.done, .done, .failed, .ahead, .ahead, .ahead])
        #expect(s.pillTint(at: 2) == Ink.red)
    }

    @Test func stoppedByYouIsGreyNotRed() throws {
        let s = try session(.stopped, .neutral, nil, [.done, .failed, .pending, .pending, .pending, .pending])
        #expect(s.pillKind(at: 1) == .stopped)
        #expect(s.pillTint(at: 1) != Ink.red)
    }

    @Test func readyToMergeWaitsOnYouAtDeploy() throws {
        let s = try session(.awaiting_merge, .waiting, .you, [.done, .done, .done, .done, .done, .pending])
        #expect(s.pillKind(at: 5) == .you)
        #expect(s.pillTint(at: 5) == Ink.amber)
    }

    @Test func queuedIsHeldNotMoving() throws {
        let s = try session(.queued, .neutral, .queue, [.current, .pending, .pending, .pending, .pending, .pending])
        #expect(s.pillKind(at: 0) == .held)
        #expect(s.pillTint(at: 0) == Ink.neutral)
    }

    @Test func aReviewRunningIsMoving() throws {
        let s = try session(.critiquing, .live, .critic, [.done, .done, .done, .current, .pending, .pending])
        #expect(s.pillKind(at: 3) == .moving)
    }

    /// Findings recorded and the agent's turn parked for a slot: the daemon hands it to the
    /// queue, and nothing on screen may claim work in motion.
    @Test func aParkedReviewIsHeldNotMoving() throws {
        let s = try session(.critiquing, .neutral, .queue, [.done, .done, .done, .current, .pending, .pending])
        #expect(s.holder?.isMoving == false)
        #expect(s.pillKind(at: 3) == .held)
        #expect(s.pillTint(at: 3) == Ink.neutral)
    }
}
