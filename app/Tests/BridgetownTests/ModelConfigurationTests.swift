import Foundation
import Testing
@testable import Bridgetown

@Suite struct ModelConfigurationTests {
    @Test func oldSettingsDefaultToAutomatic() throws {
        let base = try Fixture.snapshot().settings
        var json = try #require(JSONSerialization.jsonObject(with: JSON.encoder().encode(base)) as? [String: Any])
        json.removeValue(forKey: "models")
        let old = try JSON.decoder().decode(Settings.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(old.models == ModelSettings())
    }

    @Test func roleEditsRoundTripAndExplicitlyClearEffort() throws {
        let base = try Fixture.snapshot().settings
        var edited = base
        edited.models.monitoring = .manual(provider: .codex, model: "custom-codex", effort: "ultra")
        edited.models.reviewing = .manual(provider: .claude, model: "claude-opus-4-6", effort: nil)
        #expect(base.changedKeys(to: edited) == [.models])
        let body = try edited.patchBody([.models])
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let models = try #require(json["models"] as? [String: [String: Any]])
        #expect(models["reviewing"]?["effort"] is NSNull)
        #expect(try JSON.decoder().decode(Settings.self, from: JSON.encoder().encode(edited)) == edited)

        var pending = PendingSettings()
        let recorded = pending.record(from: base, to: edited)
        #expect(recorded)
        #expect(pending.shown(over: base).models == edited.models)
        let pendingBody = pending.beginSend()
        #expect(pendingBody == body)
    }

    @Test func codexTakeoverUsesItsSavedConfigurationAndEscapesPaths() {
        let command = SystemActions.takeOverCommand(worktree: "/repo/worktree", agentSessionId: "thread-1", home: "/Users/me", provider: .codex, sessionId: "s1", agentConfigDir: "/custom/bt's/codex/s1")
        #expect(command == #"git -C '/repo/worktree' worktree lock --reason 'Taken over from Bridgetown' . 2>/dev/null; cd '/repo/worktree' && CODEX_HOME='/custom/bt'\''s/codex/s1' codex resume 'thread-1'"#)
    }

    @Test func anUnreportedCostIsOmitted() throws {
        var session = try #require(Fixture.snapshot().sessions.first)
        session.costUsd = nil
        #expect(!session.meta(now: Date()).contains("$"))
        session.costUsd = 0
        #expect(session.meta(now: Date()).contains("$0.00"))
    }
}
