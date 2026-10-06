import Foundation
import Testing
@testable import Bridgetown

@Suite struct OutcomeGlyphTests {
    private func outcome(_ kind: AlertOutcome.Kind, _ tone: Tone = .neutral) -> AlertOutcome {
        AlertOutcome(kind: kind, headline: "x", sentence: nil, tone: tone)
    }

    private func session(_ status: Session.State) throws -> Session {
        var s = try #require(Fixture.snapshot().session(id: "ses_running"))
        s.status = status
        return s
    }

    @Test func greenCheckOnlyForResolved() throws {
        for status in [Session.State.queued, .running, .waiting, .critiquing, .ci, .awaiting_merge, .deploying, .closed, .failed, .stopped] {
            // Even if a daemon bug sent success for these, no check without `resolved`.
            let glyph = OutcomeGlyph(outcome(.session, .success), session: try session(status))
            #expect(glyph.symbol != "checkmark.circle.fill", "status \(status)")
        }
        #expect(OutcomeGlyph(outcome(.session, .success), session: try session(.resolved)).symbol == "checkmark.circle.fill")
    }

    @Test func sessionStatusRefinesTheGlyph() throws {
        #expect(OutcomeGlyph(outcome(.session), session: try session(.closed)).symbol == "minus.circle")
        #expect(OutcomeGlyph(outcome(.session, .failure), session: try session(.failed)).symbol == "xmark.octagon")
        #expect(OutcomeGlyph(outcome(.session), session: try session(.stopped)).dimmed)
        #expect(OutcomeGlyph(outcome(.session, .live), session: try session(.running)).symbol == "bolt.fill")
    }

    @Test func kindsWithoutASession() {
        #expect(OutcomeGlyph(outcome(.filtered), session: nil).dimmed)
        #expect(OutcomeGlyph(outcome(.ignored), session: nil).dimmed)
        #expect(OutcomeGlyph(outcome(.dismissed), session: nil).dimmed)
        #expect(!OutcomeGlyph(outcome(.waiting, .waiting), session: nil).dimmed)
        #expect(OutcomeGlyph(outcome(.waiting, .waiting), session: nil).symbol != OutcomeGlyph(outcome(.suggested), session: nil).symbol)
        // A teammate's alert is worth reading, but it is neither a success nor waiting on you.
        let teammate = OutcomeGlyph(outcome(.teammate), session: nil)
        #expect(!teammate.dimmed)
        #expect(teammate.symbol == "person.fill")
    }

    @Test func ciTextComesFromTheStep() throws {
        var s = try session(.ci)
        #expect(s.ciText == "Passed · 1 round")
        s.steps[4].state = .skipped
        s.ciRounds = 0
        #expect(s.ciText == "Not needed")
    }

    @Test func aSessionInAdversarialReviewIsMovingButNotTheAgent() throws {
        let s = try session(.critiquing)
        #expect(s.holder == .critic)
        #expect(s.holder?.isMoving == true)
    }
}

@Suite struct HeaderProblemsTests {
    private func problems(health: DaemonHealth = .connected, attached: Bool = false, status: Status? = nil) -> [Problem] {
        Problem.list(health: health, attached: attached, port: 47621, flash: nil, status: status)
    }

    @Test func githubBlockedIsShown() throws {
        let status = try Fixture.snapshot().status
        let lines = problems(status: status)
        #expect(lines.contains { $0.id == "github" && $0.text == "GitHub Enterprise blocks this network (IP allow list) · sessions wait" })
        #expect(lines.contains { $0.id == "grafana" })
    }

    @Test func portInUseByAnotherDaemon() {
        let lines = problems(health: .portInUse(byAnotherDaemon: true))
        #expect(lines.count == 1)
        #expect(lines[0].text.hasPrefix("Another Bridgetown daemon is running on port 47621"))
        #expect(lines[0].fix == .restartDaemon("Retry"))
    }

    @Test func portInUseBySomethingElse() {
        let lines = problems(health: .portInUse(byAnotherDaemon: false))
        #expect(lines.first?.text.hasPrefix("Port 47621 is in use") == true)
    }

    @Test func rejectedTokenWhenAttached() {
        let lines = problems(health: .rejected, attached: true)
        #expect(lines.first?.text.contains("BRIDGETOWN_API_TOKEN") == true)
    }

    @Test func aDaemonThatKeepsStoppingPointsAtItsLog() {
        let lines = problems(health: .keepsExiting("exit 1"))
        #expect(lines.count == 1)
        #expect(lines[0].text.contains("exit 1"))
        #expect(lines[0].fix == .openLogs("Open logs"))
    }

    @Test func startingSaysNothingUnlessAttached() {
        #expect(problems(health: .starting(lastError: "Daemon not reachable")).isEmpty)
        #expect(problems(health: .restarting).isEmpty)
        #expect(problems(health: .starting(lastError: "Daemon not reachable"), attached: true).first?.severity == .warning)
    }

    @Test func statusProblemsOnlyWhileConnected() throws {
        let status = try Fixture.snapshot().status
        #expect(!problems(health: .disconnected("gone"), status: status).contains { $0.id == "github" })
    }
}

@Suite struct ResolutionLineTests {
    private func closed(headline: String, resolution: String?) throws -> Session {
        var s = try #require(Fixture.snapshot().session(id: "ses_closed"))
        s.headline = headline
        s.resolution = resolution
        return s
    }

    @Test func notRepeatedWhenTheHeadlineSaysIt() throws {
        // The daemon's headline for a finished session already carries its resolution.
        #expect(try closed(headline: "Closed · root cause not found", resolution: "root cause not found").resolutionLine == nil)
        #expect(try closed(headline: "Stopped by you", resolution: "stopped by you").statusDetail == "")
    }

    @Test func shownWhenItAddsSomething() throws {
        let s = try closed(headline: "Closed · root cause not found", resolution: "Closed by you without a fix")
        #expect(s.resolutionLine == "Closed by you without a fix")
        #expect(s.statusDetail == "Closed by you without a fix")
        #expect(try closed(headline: "Closed · not fixed", resolution: "").resolutionLine == nil)
    }
}

@Suite struct ChannelNameTests {
    @Test func directMessagesTakeNoHash() {
        #expect(Format.channel("alert-dev") == "#alert-dev")
        #expect(Format.channel("DM") == "DM")
        #expect(Format.channel("group DM") == "group DM")
        #expect(Format.channel("Grafana") == "Grafana")
    }
}

@Suite struct SessionHolderTests {
    private func session(_ status: Session.State, tone: Tone = .live, reviewChannel: String? = nil) throws -> Session {
        var s = try #require(try Fixture.snapshot().sessions.first)
        s.status = status
        s.tone = tone
        s.reviewChannel = reviewChannel
        return s
    }

    @Test func inReviewIsNotWorking() throws {
        // The daemon calls "In review" live; nobody is working on it.
        let review = try session(.ci, reviewChannel: "product-approvals")
        #expect(review.holder == .reviewers)
        #expect(review.holder?.isMoving == false)
    }

    @Test func ciGreenWithoutAReviewRequestIsOnYou() throws {
        #expect(try session(.ci, tone: .waiting).holder == .you)
        #expect(try session(.ci).holder == .ci)
    }
}
