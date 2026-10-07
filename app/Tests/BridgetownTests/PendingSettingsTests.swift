import Foundation
import Testing
@testable import Bridgetown

/// Server echoes must never overwrite a field with an edit the daemon hasn't confirmed.
@Suite struct PendingSettingsTests {
    let server: Settings

    init() throws { server = try Fixture.snapshot().settings }

    /// The fields a `POST /settings` body carries, and their values.
    private func fields(_ body: Data?) throws -> [String: Any] {
        let data = try #require(body)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func edited(_ edit: (inout Settings) -> Void) -> Settings {
        var s = server
        edit(&s)
        return s
    }

    @Test func staleEchoKeepsAnUnsentEdit() {
        var pending = PendingSettings()
        let typed = edited { $0.monorepoPath = "~/code/mono" }
        let recorded = pending.record(from: server, to: typed)
        #expect(recorded)

        // An SSE snapshot from before the edit arrives while the debounce waits.
        var echo = server
        echo.pollSeconds = 60  // something else changed on the daemon
        let shown = pending.shown(over: echo)
        #expect(shown.monorepoPath == "~/code/mono")
        #expect(shown.pollSeconds == 60)
    }

    @Test func inFlightEditSurvivesEchoesUntilAnswered() throws {
        var pending = PendingSettings()
        let typed = edited { $0.monorepoPath = "~/code/mono" }
        _ = pending.record(from: server, to: typed)
        let body = try fields(pending.beginSend())
        #expect(body as? [String: String] == ["monorepoPath": "~/code/mono"])

        #expect(pending.shown(over: server).monorepoPath == "~/code/mono")
        pending.endSend()
        #expect(!pending.isPending)
        #expect(pending.shown(over: server).monorepoPath == server.monorepoPath)
    }

    @Test func keystrokesDuringAFlightStayLocal() throws {
        var pending = PendingSettings()
        let first = edited { $0.monorepoPath = "~/code/m" }
        _ = pending.record(from: server, to: first)
        #expect(pending.beginSend() != nil)

        // More typing while the first request is out.
        var second = first
        second.monorepoPath = "~/code/mono"
        _ = pending.record(from: first, to: second)

        // The first request's answer echoes the half-typed path.
        var answer = server
        answer.monorepoPath = "~/code/m"
        pending.endSend()
        #expect(pending.shown(over: answer).monorepoPath == "~/code/mono")
        let next = try fields(pending.beginSend())
        #expect(next as? [String: String] == ["monorepoPath": "~/code/mono"])
    }

    /// Two requests out at once could be answered out of order, the older answer last; and
    /// a request was never safe to call off. So the next edit waits for the answer.
    @Test func theNextRequestWaitsForTheAnswer() throws {
        var pending = PendingSettings()
        let a = edited { $0.thresholds.autoActionable = 0.6 }
        _ = pending.record(from: server, to: a)
        #expect(pending.beginSend() != nil)
        var b = a
        b.thresholds.autoActionable = 0.7
        b.autoStart.toggle()
        _ = pending.record(from: a, to: b)
        let early = pending.beginSend()
        #expect(early == nil)
        #expect(pending.shown(over: server).thresholds.autoActionable == 0.7)

        var answer = server
        answer.thresholds.autoActionable = 0.6
        pending.endSend()
        #expect(pending.shown(over: answer).thresholds.autoActionable == 0.7)
        let next = try fields(pending.beginSend())
        #expect(Set(next.keys) == ["thresholds", "autoStart"])
        pending.endSend()
        #expect(!pending.isPending)
    }

    @Test func noChangeRecordsNothing() {
        var pending = PendingSettings()
        let recorded = pending.record(from: server, to: server)
        #expect(!recorded)
        let send = pending.beginSend()
        #expect(send == nil)
    }
}
