import Foundation
import Testing
@testable import Bridgetown

/// Server echoes must never overwrite a field with an edit the daemon hasn't confirmed.
@Suite struct PendingSettingsTests {
    let server: Settings

    init() throws { server = try Fixture.snapshot().settings }

    private func take(_ pending: inout PendingSettings) -> (keys: Set<Settings.CodingKeys>, body: Data)? {
        pending.beginSend()
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
        let send = try #require(take(&pending))
        #expect(send.keys == [.monorepoPath])
        let body = try #require(JSONSerialization.jsonObject(with: send.body) as? [String: String])
        #expect(body == ["monorepoPath": "~/code/mono"])

        #expect(pending.shown(over: server).monorepoPath == "~/code/mono")
        pending.endSend(send.keys)
        #expect(!pending.isPending)
        #expect(pending.shown(over: server).monorepoPath == server.monorepoPath)
    }

    @Test func keystrokesDuringAFlightStayLocal() throws {
        var pending = PendingSettings()
        let first = edited { $0.monorepoPath = "~/code/m" }
        _ = pending.record(from: server, to: first)
        let send = try #require(take(&pending))

        // More typing while the first request is out.
        var second = first
        second.monorepoPath = "~/code/mono"
        _ = pending.record(from: first, to: second)

        // The first request's answer echoes the half-typed path.
        var answer = server
        answer.monorepoPath = "~/code/m"
        pending.endSend(send.keys)
        #expect(pending.shown(over: answer).monorepoPath == "~/code/mono")
        let next = pending.beginSend()
        #expect(next?.keys == [.monorepoPath])
    }

    @Test func overlappingRequestsHoldTheFieldUntilTheLastOneAnswers() throws {
        var pending = PendingSettings()
        let a = edited { $0.thresholds.autoActionable = 0.6 }
        _ = pending.record(from: server, to: a)
        let first = try #require(take(&pending))
        var b = a
        b.thresholds.autoActionable = 0.7
        _ = pending.record(from: a, to: b)
        let second = try #require(take(&pending))

        pending.endSend(first.keys)
        #expect(pending.shown(over: server).thresholds.autoActionable == 0.7)
        pending.endSend(second.keys)
        #expect(pending.shown(over: server).thresholds.autoActionable == server.thresholds.autoActionable)
    }

    @Test func noChangeRecordsNothing() {
        var pending = PendingSettings()
        let recorded = pending.record(from: server, to: server)
        #expect(!recorded)
        let send = pending.beginSend()
        #expect(send == nil)
    }
}
