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
    private func problems(
        connection: Store.Connection = .connected,
        daemon: DaemonProcess.State = .running(pid: 1),
        mode: DaemonProcess.Mode = .bundled(URL(fileURLWithPath: "/x")),
        status: Status? = nil
    ) -> [Problem] {
        Problem.list(connection: connection, daemonState: daemon, daemonMode: mode, port: 47621,
                     lastConnectError: nil, flash: nil, status: status)
    }

    @Test func githubBlockedIsShown() throws {
        let status = try Fixture.snapshot().status
        let lines = problems(status: status)
        #expect(lines.contains { $0.id == "github" && $0.text == "GitHub Enterprise blocks this network (IP allow list) · sessions wait" })
        #expect(lines.contains { $0.id == "grafana" })
    }

    @Test func portInUseByAnotherDaemon() {
        let lines = problems(connection: .rejected, daemon: .portInUse)
        #expect(lines.count == 1)
        #expect(lines[0].text.hasPrefix("Another Bridgetown daemon is running on port 47621"))
        #expect(lines[0].fix == .restartDaemon("Retry"))
    }

    @Test func portInUseBySomethingElse() {
        let lines = problems(connection: .connecting, daemon: .portInUse)
        #expect(lines.first?.text.hasPrefix("Port 47621 is in use") == true)
    }

    @Test func rejectedTokenWhenAttached() {
        let lines = problems(connection: .rejected, mode: .attach)
        #expect(lines.first?.text.contains("BRIDGETOWN_API_TOKEN") == true)
    }

    @Test func statusProblemsOnlyWhileConnected() throws {
        let status = try Fixture.snapshot().status
        #expect(!problems(connection: .disconnected("gone"), status: status).contains { $0.id == "github" })
    }
}

@Suite struct SystemActionsTests {
    @Test func onlyWebSlackAndRevvOpen() {
        #expect(SystemActions.openableURL("https://nocturlab.ghe.com/Merkl/monorepo/pull/1") != nil)
        #expect(SystemActions.openableURL("slack://channel?team=T1&id=C1") != nil)
        #expect(SystemActions.openableURL("revv://pr?host=h&repo=r&number=1") != nil)
        #expect(SystemActions.openableURL("HTTPS://example.com") != nil)
        for bad in ["http://example.com", "file:///etc/passwd", "x-apple.systempreferences:", "javascript:alert(1)", "/tmp/x", "", nil] {
            #expect(SystemActions.openableURL(bad) == nil, "\(bad ?? "nil")")
        }
    }
}

@Suite struct DaemonLaunchTests {
    @Test func childEnvironmentCarriesNoSecrets() {
        let inherited = [
            "PATH": "/usr/bin",
            "HOME": "/Users/me",
            "BRIDGETOWN_API_TOKEN": "dev",
            "SLACK_USER_TOKEN": "xoxp-1",
            "TYPESAFE_API_KEY": "ts_1",
            "BRIDGETOWN_DAEMON_CMD": "bun src/main.ts",
            "BRIDGETOWN_ATTACH": "1",
        ]
        let env = DaemonProcess.childEnvironment(inherited: inherited, port: 47622, home: "/Users/me")
        for key in ["BRIDGETOWN_API_TOKEN", "SLACK_USER_TOKEN", "TYPESAFE_API_KEY", "BRIDGETOWN_DAEMON_CMD", "BRIDGETOWN_ATTACH"] {
            #expect(env[key] == nil, "\(key)")
        }
        #expect(env["BRIDGETOWN_SECRETS"] == "stdin")
        #expect(env["BRIDGETOWN_PORT"] == "47622")
        #expect(env["HOME"] == "/Users/me")
        #expect(env["PATH"]?.hasSuffix(":/usr/bin") == true)
        #expect(env["PATH"]?.contains("/Users/me/.bun/bin") == true)
    }

    @Test func anExplicitSwitchBeatsTheBundledDaemon() {
        let bundled = URL(fileURLWithPath: "/Applications/Bridgetown.app/Contents/Resources/bridgetown-daemon")
        #expect(DaemonProcess.mode(environment: ["BRIDGETOWN_ATTACH": "1"], bundled: bundled) == .attach)
        #expect(DaemonProcess.mode(environment: ["BRIDGETOWN_ATTACH": "1", "BRIDGETOWN_DAEMON_CMD": "bun main.ts"], bundled: bundled) == .command("bun main.ts"))
        #expect(DaemonProcess.mode(environment: [:], bundled: bundled) == .bundled(bundled))
        #expect(DaemonProcess.mode(environment: ["BRIDGETOWN_DAEMON_CMD": " "], bundled: nil) == .missing)
    }

    @Test func secretsLineIsOneJSONObject() throws {
        let line = try DaemonProcess.Secrets(apiToken: "tok", slackUserToken: "xoxp-1", typesafeApiKey: "").line()
        #expect(line.last == UInt8(ascii: "\n"))
        #expect(line.dropLast().contains(UInt8(ascii: "\n")) == false)
        let json = try #require(JSONSerialization.jsonObject(with: line.dropLast()) as? [String: String])
        #expect(json == ["apiToken": "tok", "slackUserToken": "xoxp-1", "typesafeApiKey": ""])
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
        #expect(Session.breakdown([review, review]) == "2 in review")
    }

    @Test func ciGreenWithoutAReviewRequestIsOnYou() throws {
        #expect(try session(.ci, tone: .waiting).holder == .you)
        #expect(try session(.ci).holder == .ci)
    }

    @Test func breakdownFollowsHolderOrder() throws {
        let sessions = [
            try session(.ci, reviewChannel: "general-approvals"),
            try session(.running),
            try session(.awaiting_merge, tone: .waiting),
            try session(.resolved, tone: .success),
        ]
        #expect(Session.breakdown(sessions) == "1 working · 1 on you · 1 in review")
    }
}

@Suite struct BreakdownLimitTests {
    @Test func limitKeepsTheLeadingGroups() throws {
        var running = try #require(try Fixture.snapshot().sessions.first)
        running.status = .running
        var review = running
        review.status = .ci
        review.reviewChannel = "product-approvals"
        #expect(Session.breakdown([review, running, review], limit: 1) == "1 working")
        #expect(Session.breakdown([review, review], limit: 1) == "2 in review")
    }
}
