import Testing
@testable import Bridgetown

/// How each step stands (`Session.stepKind`), for the states the daemon sends.
@Suite struct StepModelTests {
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
        #expect(s.stepKinds == [.done, .done, .done, .done, .done, .resolved])
        #expect(s.stepTint(at: 5) == Ink.green)
    }

    /// Nothing to release: the daemon skips Deploy, and the outcome sits on CI.
    @Test func resolvedWithNoDeployIsGreenOnTheLastStepItReached() throws {
        let s = try session(.resolved, .success, nil, [.done, .done, .done, .done, .done, .skipped],
                            labels: ["Diagnose", "Fix", "PR", "Review", "CI", "No deploy"])
        #expect(s.stepKinds == [.done, .done, .done, .done, .resolved, .skipped])
        #expect(s.stepTint(at: 4) == Ink.green)
        #expect(s.focusedStepIndex == 4)
        #expect(s.focusedStepDescription == "Step 5 of 6, CI, Done")
        #expect(s.stepStatus(at: 5) == "Not needed")
    }

    @Test func closedStopsGreyWhereItStopped() throws {
        let s = try session(.closed, .neutral, nil, [.failed, .pending, .pending, .pending, .pending, .skipped],
                            labels: ["Root cause?", "Fix", "No PR", "Review", "CI", "Deploy"])
        #expect(s.stepKind(at: 0) == .stopped)
        #expect(s.stepTint(at: 0) == Ink.neutral)
        #expect(!s.stepKinds.contains(.resolved))
        #expect(s.focusedStepDescription == "Step 1 of 6, Root cause?, Stopped")
        #expect(s.stepStatus(at: 1) == "Not reached")
    }

    @Test func failedIsRedWhereItFailed() throws {
        let s = try session(.failed, .failure, nil, [.done, .done, .failed, .pending, .pending, .pending])
        #expect(s.stepKinds == [.done, .done, .failed, .ahead, .ahead, .ahead])
        #expect(s.stepTint(at: 2) == Ink.red)
    }

    @Test func stoppedByYouIsGreyNotRed() throws {
        let s = try session(.stopped, .neutral, nil, [.done, .failed, .pending, .pending, .pending, .pending])
        #expect(s.stepKind(at: 1) == .stopped)
        #expect(s.stepTint(at: 1) != Ink.red)
    }

    @Test func readyToMergeWaitsOnYouAtDeploy() throws {
        let s = try session(.awaiting_merge, .waiting, .you, [.done, .done, .done, .done, .done, .pending])
        #expect(s.stepKind(at: 5) == .you)
        #expect(s.stepTint(at: 5) == Ink.amber)
    }

    @Test func queuedIsHeldNotMoving() throws {
        let s = try session(.queued, .neutral, .queue, [.current, .pending, .pending, .pending, .pending, .pending])
        #expect(s.stepKind(at: 0) == .held)
        #expect(s.stepTint(at: 0) == Ink.neutral)
        #expect(s.stepStatus(at: 0) == "Queued")
    }

    @Test func aReviewRunningIsMoving() throws {
        let s = try session(.critiquing, .live, .critic, [.done, .done, .done, .current, .pending, .pending])
        #expect(s.stepKind(at: 3) == .moving)
    }

    /// Findings recorded and the agent's turn parked for a slot: the daemon hands it to the
    /// queue, and nothing on screen may claim work in motion.
    @Test func aParkedReviewIsHeldNotMoving() throws {
        let s = try session(.critiquing, .neutral, .queue, [.done, .done, .done, .current, .pending, .pending])
        #expect(s.holder?.isMoving == false)
        #expect(s.stepKind(at: 3) == .held)
        #expect(s.stepTint(at: 3) == Ink.neutral)
    }
}
