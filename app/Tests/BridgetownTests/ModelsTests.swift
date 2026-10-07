import Foundation
import Testing
@testable import Bridgetown

@Suite struct SnapshotDecoding {
    @Test func aProdFindingOpensInGrafana() throws {
        var alert = try #require(try Fixture.snapshot().alerts.first)
        #expect(alert.permalinkLabel == "Open in Slack")
        alert.source = try JSONDecoder().decode(AlertView.Source.self, from: Data(#""watch""#.utf8))
        #expect(alert.source == .watch && alert.permalinkLabel == "Open in Grafana")
    }

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
        #expect(running.steps.map(\.key) == [.diagnose, .fix, .pr, .critique, .ci, .deploy])
        #expect(running.critiqueLine == "Passed · 1 round of fixes · 2 dropped by Jev")
        #expect(running.holder == .you)
        #expect(running.ciLine == "Passed · 1 round")
        #expect(running.steps.map(\.detail) == ["Cause found", nil, "#3340", running.critiqueLine, "Passed · 1 round", nil])
        #expect(running.channelLabel == "#alert-releases")
        #expect(snap.metrics.sessions == .init(started: 2, resolved: 0))
        #expect(snap.settings.adversarialReview && snap.settings.thresholds.findingReal == 0.6)
        #expect(snap.settings.watchProd)
        #expect(!snap.isQuiet)
        var quiet = snap
        quiet.actions = []
        quiet.alerts = []
        quiet.sessions = quiet.sessions.filter { !$0.isActive }
        #expect(quiet.isQuiet)
        #expect(running.revvUrl != nil && running.reviewChannel == "product-approvals")
        let closed = try #require(snap.session(id: "ses_closed"))
        #expect(!closed.acceptsMessages)
        #expect(closed.rootCauseFound == false)
        #expect(closed.steps.first?.label == "Root cause?")
        #expect(closed.holder == nil)

        let kinds = snap.alerts.map(\.outcome.kind)
        #expect(kinds == [.session, .session, .filtered, .dismissed, .waiting])
        #expect(snap.alerts[2].outcome.sentence == "No agent ran. A rule filtered it before triage.")
        #expect(snap.alerts[4].channelLabel == "DM")
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
        // Markdown, with people by name: the daemon translated the mrkdwn.
        #expect(detail.raw.contains("[dashboard](<https://grafana.merkl.xyz/d/abc>)"))
        #expect(detail.raw.hasSuffix("@Hugo"))
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
        // The daemon dropped "pending" from triage decisions and outcome kinds; one still sent is just unknown.
        var triage = try #require(alerts[1]["triage"] as? [String: Any])
        triage["decision"] = "pending"
        alerts[1]["triage"] = triage
        var pendingOutcome = try #require(alerts[1]["outcome"] as? [String: Any])
        pendingOutcome["kind"] = "pending"
        alerts[1]["outcome"] = pendingOutcome
        json["alerts"] = alerts
        let snap = try JSON.decoder().decode(Snapshot.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(snap.status.github == .unknown)
        #expect(snap.alerts[0].outcome.kind == .unknown)
        #expect(snap.alerts[0].outcome.tone == .unknown)
        #expect(snap.alerts[1].triage.decision == .unknown)
        #expect(snap.alerts[1].outcome.kind == .unknown)
    }
}

@Suite struct SettingsPatching {
    @Test func changedKeysAreTopLevelFields() throws {
        let base = try Fixture.snapshot().settings
        var next = base
        next.thresholds.autoActionable = 0.9
        next[channel: "C0B001L8UQ1"] = true
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
        // A changed nested object goes whole.
        #expect((json["thresholds"] as? [String: Any])?.count == 8)
    }

    @Test func channelSubscriptIgnoresUnknownIds() throws {
        var settings = try Fixture.snapshot().settings
        settings[channel: "nope"] = true
        #expect(settings == (try Fixture.snapshot().settings))
        #expect(settings[channel: "C0AUKD42N3U"])
        #expect(!settings[channel: "C0B001L8UQ1"])
    }
}

@Suite struct BoardDecoding {
    @Test func decodesTheContract() throws {
        let board = try Fixture.decode(Board.self, "board")
        #expect(board.panels.count == 3)
        #expect(board.panels[0].series[0].points[0] == .init(t: 1_791_009_720, v: 230))
        #expect(board.panels[1].error == "timed out")
        #expect(board.deploys.first?.status == .deployed)
        #expect(board.stepLabel == "30m")
        // The prod watcher's judgement, on the panel it watches only.
        #expect(board.panels[0].usual != nil && board.panels[0].spike != nil)
        #expect(board.lead?.id == "api_5xx")
        #expect(board.panels[2].usual == nil && board.panels[2].spike == nil)
    }

    @Test func aPointIsAPair() throws {
        #expect(throws: DecodingError.self) { try JSON.decoder().decode(Board.Panel.Point.self, from: Data("[1, 2, 3]".utf8)) }
        #expect(try JSON.decoder().decode(Board.Panel.Point.self, from: Data("[1, 2]".utf8)) == Board.Panel.Point(t: 1, v: 2))
    }

    @Test func nullMeansNoBoard() throws {
        #expect(try JSON.decoder().decode(Board?.self, from: Data("null".utf8)) == nil)
    }

    @Test func unitsFormatForTheirKind() {
        #expect(Board.Panel.Unit.ms.format(423.4) == "423 ms")
        #expect(Board.Panel.Unit.ms.format(2300) == "2.3 s")
        #expect(Board.Panel.Unit.ms.format(2000) == "2 s")
        #expect(Board.Panel.Unit.count.format(20.9) == "21")
        #expect(Board.Panel.Unit.count.format(4.5) == "4.5")
        #expect(Board.Panel.Unit.count.format(3) == "3")
        #expect(Board.Panel.Unit.count.format(1172) == "1.2k")
        #expect(Board.Panel.Unit.count.format(34_400) == "34k")
        #expect(Board.Panel.Unit.per_s.format(0.15) == "0.15/s")
        #expect(Format.cost(0.97) == "$0.97")
        #expect(Board.Panel.Unit.bytes.format(35.25 * 1_073_741_824) == "35.3 GB")
        #expect(Board.Panel.Unit.bytes.format(567 * 1_048_576) == "567 MB")
    }

    @Test func summarySumsSeriesAtEachTimestamp() {
        let panel = Board.Panel(
            id: "pods", title: "Pods", unit: .count,
            series: [
                .init(label: "v1", points: [.init(t: 100, v: 4), .init(t: 200, v: 4), .init(t: 300, v: 1)]),
                .init(label: "v2", points: [.init(t: 200, v: 2), .init(t: 300, v: 6)]),
            ],
            latest: 7, link: "x"
        )
        let summary = panel.summary
        #expect(summary?.peak == .init(at: Date(timeIntervalSince1970: 300), value: 7))
        #expect(summary?.low == .init(at: Date(timeIntervalSince1970: 100), value: 4))
        #expect(summary?.median == 6)
        #expect(summary?.total == 17)
    }

    @Test func noSummaryWithoutSamples() {
        let empty = Board.Panel(id: "a", title: "A", unit: .ms, series: [], latest: nil, link: "x")
        #expect(empty.summary == nil)
        var failed = empty
        failed.series = [.init(label: "A", points: [.init(t: 100, v: 1)])]
        failed.error = "timed out"
        #expect(failed.summary == nil)
    }

    @Test func seriesValueIsTheNearestSampleOrTheLast() {
        let s = Board.Panel.Series(label: "A", points: [.init(t: 100, v: 1), .init(t: 200, v: 2), .init(t: 300, v: 3)])
        #expect(Board.Panel.value(of: s, at: nil) == 3)
        #expect(Board.Panel.value(of: s, at: Date(timeIntervalSince1970: 190)) == 2)
    }
}

@Suite struct LogSweepDecoding {
    @Test func decodesTheDaemonsSweep() throws {
        let sweep = try Fixture.decode(LogSweep.self, "log-sweep")
        #expect(sweep.sweptAt != nil)
        #expect(sweep.patterns.map(\.behaviour) == [.surging, .steady])
        #expect(sweep.patterns[0].headline == "Surging error · 55×")
        #expect(sweep.patterns[0].verdictLine == "Jev · problem 46% · agent 38% · users 21%")
        #expect(sweep.patterns[1].headline == "Risky warning")
        #expect(sweep.patterns[1].sourcesLabel == "merkl-precompute-* +1")
    }

    private let json = """
    {"sweptAt":"2026-10-04T11:55:00.000Z","link":"https://grafana.internal.merkl.xyz/explore?x","error":null,
     "patterns":[
       {"key":"errors:1","level":"error","behaviour":"surging","suspicious":true,"sources":["merkl-compute-*"],
        "message":"RPC call failed with status <N>","example":"RPC call failed with status 429","versions":["v1.62.35"],
        "recent":220,"usual":4,"jev":{"problem":0.46,"agent":0.38,"users":0.21,"at":"2026-10-04T11:55:00.000Z"},
        "alertId":null,"link":"https://grafana.internal.merkl.xyz/explore?y"},
       {"key":"warnings:2","level":"warning","behaviour":"steady","suspicious":true,"sources":["merkl-precompute-*","merkl-compute-*"],
        "message":"Rate limited","example":"Rate limited","versions":[],"recent":1813,"usual":1812.4,"jev":null,
        "alertId":"watch:log:1:2","link":"https://grafana.internal.merkl.xyz/explore?z"},
       {"key":"errors:3","level":"fatal","behaviour":"quiet","suspicious":false,"sources":[],"message":"m","example":"e",
        "versions":[],"recent":12,"usual":11.5,"jev":null,"alertId":null,"link":"x"}]}
    """

    @Test func decodesTheContract() throws {
        let sweep = try JSON.decoder().decode(LogSweep.self, from: Data(json.utf8))
        #expect(sweep.sweptAt != nil)
        #expect(sweep.patterns.count == 3)
        #expect(sweep.patterns[0].jev?.problem == 0.46)
        #expect(sweep.patterns[1].alertId == "watch:log:1:2")
        // A level or behaviour from a newer daemon doesn't blank the list.
        #expect(sweep.patterns[2].level == .unknown)
        #expect(sweep.patterns[2].behaviour == .unknown)
    }

    @Test func labelsSayWhatThePatternDid() throws {
        let p = try JSON.decoder().decode(LogSweep.self, from: Data(json.utf8)).patterns
        #expect(p[0].headline == "Surging error · 55×")
        #expect(p[0].verdictLine == "Jev · problem 46% · agent 38% · users 21%")
        #expect(p[1].headline == "Risky warning")
        #expect(p[1].sourcesLabel == "merkl-precompute-* +1")
        #expect(p[1].verdictLine == "Not asked yet")
        #expect(p[2].headline == "Steady error")
        #expect(p[2].sourcesLabel == "unknown")
        #expect(p[2].verdictLine == nil)
    }
}

@Suite struct MemoryDecoding {
    @Test func decodesTheDaemonContract() throws {
        let status = try Fixture.decode(MemoryStatus.self, "memory")
        #expect(status.enabled)
        #expect(status.path.hasSuffix("/memory"))
        #expect(status.pending == 3)
        #expect(status.lastLearnedAt != nil)
        #expect(status.lastDreamedAt == nil)
        #expect(status.error == nil)
        #expect(status.label == "Ready")
        #expect(!status.isWorking)
        #expect(try Fixture.snapshot().settings.memory)
    }

    @Test func memoryToggleIsAnIndependentSettingsPatch() throws {
        var settings = try Fixture.snapshot().settings
        let before = settings
        settings.memory = false
        #expect(before.changedKeys(to: settings) == [.memory])
        let object = try JSONSerialization.jsonObject(with: settings.patchBody([.memory])) as? [String: Bool]
        #expect(object == ["memory": false])
    }
}
