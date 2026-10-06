import Foundation
import SwiftUI
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

    /// The reason is the client's, and it names the daemon already.
    @Test func aDisconnectSaysTheDaemonOnce() {
        #expect(problems(health: .disconnected("Daemon not reachable")).first?.text == "Disconnected · Daemon not reachable")
    }

    @Test func statusProblemsOnlyWhileConnected() throws {
        let status = try Fixture.snapshot().status
        #expect(!problems(health: .disconnected("gone"), status: status).contains { $0.id == "github" })
    }

    /// The overview keeps the last snapshot while the daemon is away: the status line says
    /// it isn't live rather than let it pass for the present.
    @Test func theStatusLineSaysWhenTheOverviewIsNotLive() {
        #expect(StatusSummary.connectionLine(.portInUse(byAnotherDaemon: false), showingLast: true)
            == "Daemon couldn't start · showing the last update")
        #expect(StatusSummary.connectionLine(.disconnected("gone"), showingLast: true)
            == "Reconnecting… · showing the last update")
        #expect(StatusSummary.connectionLine(.starting(lastError: nil), showingLast: false) == "Connecting…")
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

@Suite struct ActivityLineTests {
    private func session(_ status: Session.State, activity: String) throws -> Session {
        var s = try #require(Fixture.snapshot().session(id: "ses_running"))
        s.status = status
        s.activity = activity
        return s
    }

    /// Waiting on you, the session's card stands under its headline: "Asked: Switch the
    /// keeper to the fallback provider?" would say the card's question twice.
    @Test func notRepeatedOverTheCardItWaitsOn() throws {
        let asked = try session(.waiting, activity: "Asked: Switch the keeper to the fallback provider?")
        #expect(asked.activityLine(besideCard: true) == nil)
        #expect(asked.activityLine(besideCard: false) == "Asked: Switch the keeper to the fallback provider?")
        #expect(try session(.awaiting_merge, activity: "#3345 approved and green, ready to merge").activityLine(besideCard: true) == nil)
    }

    @Test func shownWhileTheAgentWorks() throws {
        let running = try session(.running, activity: "Guarding computeApr")
        #expect(running.activityLine(besideCard: true) == "Guarding computeApr")
        #expect(try session(.running, activity: "").activityLine(besideCard: false) == nil)
        #expect(try session(.closed, activity: "Guarding computeApr").activityLine(besideCard: false) == nil)
    }
}

@Suite struct ElapsedTests {
    /// A row's time and the detail's meta line say the same: running, it counts on to now;
    /// ended, it stops at the session's last update.
    @Test func stopsWhenTheSessionEnds() throws {
        var s = try #require(Fixture.snapshot().session(id: "ses_running"))
        s.status = .running
        s.startedAt = Date(timeIntervalSince1970: 1_791_100_000)
        s.updatedAt = s.startedAt.addingTimeInterval(12 * 60)
        let now = s.startedAt.addingTimeInterval(95 * 60)
        #expect(s.elapsed(now: now) == "1h 35m")
        s.status = .resolved
        #expect(s.elapsed(now: now) == "12m")
        #expect(s.meta(now: now).components(separatedBy: " · ").contains("12m"))
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

@Suite struct FailedActionTests {
    /// Only an agent that failed is marked red on its row; a review of a session that merely
    /// ended without a fix is not a failure.
    @Test func failureComesFromTheSessionNotTheKind() throws {
        var snapshot = try Fixture.snapshot()
        var review = try #require(snapshot.actions.first { $0.id == "act_review_1" })
        #expect(!review.failed(in: snapshot))
        let closed = try #require(snapshot.sessions.firstIndex { $0.id == review.sessionId })
        snapshot.sessions[closed].tone = .failure
        #expect(review.failed(in: snapshot))
        review.kind = .rerun
        #expect(review.failed(in: nil))
        review.kind = .merge
        #expect(!review.failed(in: snapshot))
    }
}

@Suite struct TimeFormatTests {
    private let now = Date(timeIntervalSince1970: 1_791_115_200)

    private func ago(_ seconds: TimeInterval) -> Date { now.addingTimeInterval(-seconds) }

    @Test func relativeCountsWholeUnits() {
        #expect(Format.relative(ago(44), now: now) == "now")
        #expect(Format.relative(ago(50), now: now) == "1m")
        #expect(Format.relative(ago(3599), now: now) == "59m")
        #expect(Format.relative(ago(3600), now: now) == "1h")
        #expect(Format.relative(ago(6 * 86_400), now: now) == "6d")
    }

    @Test func agoNeverPutsAgoAfterADate() {
        #expect(Format.ago(ago(10), now: now) == "just now")
        #expect(Format.ago(ago(240), now: now) == "4m ago")
        let old = Format.ago(ago(9 * 86_400), now: now)
        #expect(!old.hasSuffix("ago"))
        #expect(old == Format.relative(ago(9 * 86_400), now: now))
    }

    @Test func clockIsTwentyFourHourInAnyLocale() throws {
        let afternoon = try #require(Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: 4, hour: 14, minute: 5)))
        let morning = try #require(Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: 4, hour: 2, minute: 5)))
        #expect(afternoon.formatted(Format.clock) == "14:05")
        #expect(morning.formatted(Format.clock) == "02:05")
    }

    /// A view outside the island's tick reads the app's clock when it draws, not a time
    /// fixed when the app started.
    @Test func viewsReadTheAppClockByDefault() {
        let before = AppClock.now
        let read = EnvironmentValues().now
        #expect(read >= before && read.timeIntervalSince(before) < 1)
    }

    @Test func aBoardEndsNowWithinTenMinutes() throws {
        let json = """
        {"title":"Incidents","from":"2026-10-04T11:00:00Z","to":"2026-10-04T12:00:00Z","stepSeconds":120,
         "marker":null,"fetchedAt":"2026-10-04T12:00:00Z","error":null,"panels":[],"deploys":[]}
        """
        var board = try JSON.decoder().decode(Board.self, from: Data(json.utf8))
        board.to = now.addingTimeInterval(-300)
        #expect(board.endsNow(at: now))
        board.to = now.addingTimeInterval(-3600)
        #expect(!board.endsNow(at: now))
    }

    /// Each column holds the largest sample of its bucket; a sample outside the window
    /// draws nothing, and the crosshair stands in the middle of a bucket.
    @Test func aPanelIsCutIntoTheBoardsBuckets() throws {
        let json = """
        {"title":"Incidents","from":"2026-10-04T11:00:00Z","to":"2026-10-04T11:10:00Z","stepSeconds":120,
         "marker":null,"fetchedAt":"2026-10-04T11:10:00Z","error":null,"deploys":[],
         "panels":[{"id":"5xx","title":"API 5xx","unit":"count","latest":3,"link":"https://grafana.example/d/x","error":null,
           "series":[{"label":"5xx","points":[[1791111610,2],[1791111660,5],[1791111730,3],[1791112300,1]]}]}]}
        """
        let board = try JSON.decoder().decode(Board.self, from: Data(json.utf8))
        let panel = try #require(board.panels.first)
        #expect(board.columns == 5)
        #expect(board.buckets(of: panel).map(\.values) == [[5, 3, nil, nil, nil]])
        #expect(board.time(ofColumn: 0) == board.from.addingTimeInterval(60))
        #expect(panel.chartTop == 5 * 1.15)
    }
}

@Suite struct ToneHeadlineTests {
    private func colours(_ text: AttributedString) -> [(String, Color?)] {
        text.runs.map { (String(text[$0.range].characters), $0.foregroundColor) }
    }

    /// The status word takes the tone's colour; what follows keeps the line's grey.
    @Test func aStatusWordTakesItsTone() {
        let runs = colours(Tone.live.styledHeadline("In review · #product-approvals"))
        #expect(runs.map(\.0) == ["In review", " · #product-approvals"])
        #expect(runs.map(\.1) == [Ink.blue, nil])
    }

    /// "Queued", "Closed", "Pierre is on it": grey like the rest of the line, not white.
    @Test func aNeutralWordKeepsTheLinesGrey() {
        #expect(colours(Tone.neutral.styledHeadline("Closed · root cause not found")).allSatisfy { $0.1 == nil })
        #expect(colours(Tone.neutral.styledHeadline("Queued")).allSatisfy { $0.1 == nil })
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

    /// Only motion pulses, on the row and in the detail alike; an ended session is still,
    /// not a ring that says it waits on someone.
    @Test func theDotPulsesOnlyWhileSomethingMovesIt() throws {
        #expect(try session(.running).dot == .moving)
        #expect(try session(.ci).dot == .moving)
        #expect(try session(.ci, reviewChannel: "product-approvals").dot == .waiting)
        #expect(try session(.critiquing, tone: .neutral).dot == .waiting)
        #expect(try session(.queued, tone: .neutral).dot == .waiting)
        #expect(try session(.waiting, tone: .waiting).dot == .still)
        #expect(try session(.resolved, tone: .success).dot == .still)
        #expect(try session(.closed, tone: .neutral).dot == .still)
    }
}
