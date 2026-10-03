import Foundation
import Testing
@testable import Bridgetown

@Suite struct SnapshotDecoding {
    @Test func decodesEveryContractField() throws {
        let snap = try Fixture.snapshot()

        #expect(snap.status.github == .blocked)
        #expect(snap.status.grafanaMcp == .down)
        #expect(snap.status.lastPollAt != nil)
        #expect(snap.status.error == nil)

        let merge = try #require(snap.action(id: "act_merge_1"))
        #expect(merge.kind == .merge)
        #expect(merge.inFlight)
        #expect(merge.dismissCloses)
        let answer = try #require(snap.action(id: "act_answer_1"))
        #expect(answer.options == ["prod", "staging"])
        #expect(!answer.inFlight && !answer.dismissCloses)
        #expect(snap.action(id: "act_escalate_1")?.url?.hasPrefix("revv://") == true)

        let running = try #require(snap.session(id: "ses_running"))
        #expect(running.acceptsMessages)
        #expect(running.status == .awaiting_merge)
        #expect(running.tone == .waiting)
        #expect(running.steps.map(\.key) == [.diagnose, .fix, .pr, .ci, .deploy])
        #expect(running.revvUrl != nil && running.reviewChannel == "product-approvals")
        let closed = try #require(snap.session(id: "ses_closed"))
        #expect(!closed.acceptsMessages)
        #expect(closed.rootCauseFound == false)
        #expect(closed.steps.first?.label == "Root cause?")

        let kinds = snap.alerts.map(\.outcome.kind)
        #expect(kinds == [.session, .session, .filtered, .dismissed, .waiting])
        #expect(snap.alerts[2].outcome.sentence == "Recovery notice")
        #expect(snap.alerts[0].outcome.sentence == nil)
        #expect(snap.alerts[4].outcome.tone == .waiting)

        #expect(snap.settings.inbox)
        #expect(snap.settings.quietHours == .init(enabled: true, start: "22:00", end: "08:00"))
    }

    @Test func roundTripsThroughTheEncoder() throws {
        let snap = try Fixture.snapshot()
        let again = try JSON.decoder().decode(Snapshot.self, from: JSON.encoder().encode(snap))
        #expect(again.actions == snap.actions)
        #expect(again.settings == snap.settings)
    }

    @Test func alertDetailIsFlat() throws {
        let detail = try Fixture.decode(AlertDetail.self, "alert-detail")
        #expect(detail.alert.outcome.kind == .dismissed)
        #expect(detail.raw.contains("dashboard"))
        #expect(detail.events.count == 2)
        #expect(detail.session == nil)
        #expect(detail.actions.isEmpty)
    }

    /// The old wire shape nested `raw` and `events` inside `alert`; it must not decode
    /// silently into an empty detail.
    @Test func nestedLegacyAlertDetailFails() throws {
        var json = try #require(JSONSerialization.jsonObject(with: Fixture.data("alert-detail")) as? [String: Any])
        var alert = try #require(json["alert"] as? [String: Any])
        alert["raw"] = json.removeValue(forKey: "raw")
        alert["events"] = json.removeValue(forKey: "events")
        json["alert"] = alert
        let data = try JSONSerialization.data(withJSONObject: json)
        #expect(throws: DecodingError.self) { try JSON.decoder().decode(AlertDetail.self, from: data) }
    }

    @Test func missingContractFieldFails() throws {
        var json = try #require(JSONSerialization.jsonObject(with: Fixture.data("snapshot")) as? [String: Any])
        var alerts = try #require(json["alerts"] as? [[String: Any]])
        alerts[0]["outcome"] = nil
        json["alerts"] = alerts
        let data = try JSONSerialization.data(withJSONObject: json)
        #expect(throws: DecodingError.self) { try JSON.decoder().decode(Snapshot.self, from: data) }
    }

    @Test func unknownEnumValuesDecodeAsUnknown() throws {
        var json = try #require(JSONSerialization.jsonObject(with: Fixture.data("snapshot")) as? [String: Any])
        var status = try #require(json["status"] as? [String: Any])
        status["github"] = "rate_limited"
        json["status"] = status
        var alerts = try #require(json["alerts"] as? [[String: Any]])
        var outcome = try #require(alerts[0]["outcome"] as? [String: Any])
        outcome["kind"] = "archived"
        outcome["tone"] = "sparkly"
        alerts[0]["outcome"] = outcome
        json["alerts"] = alerts
        let snap = try JSON.decoder().decode(Snapshot.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(snap.status.github == .unknown)
        #expect(snap.alerts[0].outcome.kind == .unknown)
        #expect(snap.alerts[0].outcome.tone == .unknown)
    }
}

@Suite struct SettingsPatching {
    @Test func changedKeysAreTopLevelFields() throws {
        let base = try Fixture.snapshot().settings
        var next = base
        next.thresholds.autoActionable = 0.9
        next[channel: "C0UPTIME"] = true
        next.quietHours.start = "23:00"
        #expect(base.changedKeys(to: next) == [.thresholds, .channels, .quietHours])
        #expect(base.changedKeys(to: base).isEmpty)
    }

    @Test func patchBodyHoldsOnlyTheGivenKeys() throws {
        var settings = try Fixture.snapshot().settings
        settings.monorepoPath = "~/src/monorepo"
        let body = try settings.patchBody([.monorepoPath, .thresholds])
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(Set(json.keys) == ["monorepoPath", "thresholds"])
        #expect(json["monorepoPath"] as? String == "~/src/monorepo")
        // Partial<Settings> is shallow: a nested object goes whole.
        #expect((json["thresholds"] as? [String: Any])?.count == 5)
    }

    @Test func channelSubscriptIgnoresUnknownIds() throws {
        var settings = try Fixture.snapshot().settings
        settings[channel: "nope"] = true
        #expect(settings == (try Fixture.snapshot().settings))
        #expect(settings[channel: "C0AUKD42N3U"])
        #expect(!settings[channel: "C0UPTIME"])
    }
}

@Suite struct BoardDecoding {
    private let json = """
    {"title":"API · /v4/opportunities","from":"2026-10-04T03:00:00.000Z","to":"2026-10-04T12:00:00.000Z",
     "stepSeconds":720,"marker":"2026-10-04T09:00:00.000Z","fetchedAt":"2026-10-04T12:00:01.000Z","error":null,
     "panels":[{"id":"api_5xx","title":"API 5xx","unit":"count","series":[{"label":"API 5xx","points":[[1791075600,3],[1791076320,0]]}],
                "latest":0,"link":"https://grafana.internal.merkl.xyz/d/pihjbxm?from=1&to=2","error":null},
               {"id":"api_p99","title":"API p99 latency","unit":"ms","series":[],"latest":null,"link":"x","error":"timed out"}],
     "deploys":[{"at":"2026-10-04T08:41:00.000Z","image":"merkl-api","version":"v1.35.11","stage":"engine","status":"deployed"}]}
    """

    @Test func decodesTheContract() throws {
        let board = try JSON.decoder().decode(Board.self, from: Data(json.utf8))
        #expect(board.panels.count == 2)
        #expect(board.panels[0].series[0].points[0] == [1791075600, 3])
        #expect(board.panels[1].error == "timed out")
        #expect(board.deploys.first?.status == .deployed)
        #expect(board.stepLabel == "12m")
    }

    @Test func nullMeansNoBoard() throws {
        #expect(try JSON.decoder().decode(Board?.self, from: Data("null".utf8)) == nil)
    }

    @Test func unitsFormatForTheirKind() {
        #expect(Board.Panel.Unit.ms.format(423.4) == "423 ms")
        #expect(Board.Panel.Unit.ms.format(2300) == "2.3 s" || Board.Panel.Unit.ms.format(2300) == "2,3 s")
    }
}
