import AppKit
import Foundation
import Testing
@testable import Bridgetown

@Suite struct RowSelectionTests {
    private let order = ["a", "b", "c", "d", "e"]

    @Test func plainClickDoesNotPickWhenNothingIsPicked() {
        var s = RowSelection()
        let picked = s.click("b", in: order, modifiers: [])
        #expect(!picked)
        #expect(s.isEmpty)
    }

    @Test func commandClickToggles() {
        var s = RowSelection()
        let first = s.click("b", in: order, modifiers: .command)
        #expect(first)
        #expect(s.ids == ["b"])
        let second = s.click("b", in: order, modifiers: .command)
        #expect(second)
        #expect(s.isEmpty)
    }

    @Test func plainClickTogglesWhilePicking() {
        var s = RowSelection()
        _ = s.click("a", in: order, modifiers: .command)
        let picked = s.click("c", in: order, modifiers: [])
        #expect(picked)
        #expect(s.ids == ["a", "c"])
    }

    @Test func shiftClickPicksTheRunFromTheLastToggled() {
        var s = RowSelection()
        _ = s.click("d", in: order, modifiers: .command)
        _ = s.click("b", in: order, modifiers: .shift)
        #expect(s.ids == ["b", "c", "d"])
    }

    @Test func shiftClickWithoutAnAnchorPicksOne() {
        var s = RowSelection()
        _ = s.click("c", in: order, modifiers: .shift)
        #expect(s.ids == ["c"])
    }

    @Test func groupTogglePicksAllThenNone() {
        var s = RowSelection()
        s.toggle("a")
        s.toggle(all: ["a", "b"])
        #expect(s.ids == ["a", "b"])
        s.toggle(all: ["a", "b"])
        #expect(s.isEmpty)
    }

    @Test func rowsThatLeaveAreForgotten() {
        var s = RowSelection()
        s.set(["a", "b"])
        s.keep(only: ["b", "c"])
        #expect(s.ids == ["b"])
    }
}

@Suite struct ActionGroupTests {
    private func action(_ id: String, _ kind: Action.Kind, label: String = "Go", url: String? = nil, inFlight: Bool = false) -> Action {
        Action(
            id: id, kind: kind, title: id, detail: "", primaryLabel: label, options: [],
            sessionId: nil, alertId: nil, url: url, inFlight: inFlight, dismissCloses: false, createdAt: .now
        )
    }

    @Test func groupsFollowTheirOrderAndSkipEmptyOnes() throws {
        var snap = try Fixture.snapshot()
        snap.actions = [action("1", .review), action("2", .merge), action("3", .escalate), action("4", .investigate), action("5", .release)]
        let groups = snap.actionGroups
        #expect(groups.map(\.group) == [.answer, .ship, .investigate, .retry])
        #expect(groups[1].actions.map(\.id) == ["2", "5"])
    }

    @Test func sharedPrimaryNeedsTheSameKindAndLabel() {
        #expect([action("1", .investigate, label: "Investigate"), action("2", .investigate, label: "Investigate")].sharedPrimary == "Investigate")
        #expect([action("1", .review, label: "Retry"), action("2", .review, label: "Close session")].sharedPrimary == nil)
        #expect([action("1", .merge, label: "Go"), action("2", .release, label: "Go")].sharedPrimary == nil)
    }

    @Test func noSharedPrimaryForInputLinksOrInFlight() {
        #expect([action("1", .answer), action("2", .answer)].sharedPrimary == nil)
        // One browser tab per row is not a bulk action.
        #expect([action("1", .escalate, url: "https://slack.com/x"), action("2", .escalate, url: "https://slack.com/y")].sharedPrimary == nil)
        #expect([action("1", .merge), action("2", .merge, inFlight: true)].sharedPrimary == nil)
        #expect([Action]().sharedPrimary == nil)
    }
}

@Suite struct OverviewPicksTests {
    @Test func startingAPickInOneListClearsTheOthers() {
        var picks = OverviewPicks()
        picks.needsYou.toggle("a")
        picks.agents.toggle("b")
        #expect(picks.needsYou.isEmpty)
        #expect(picks.agents.ids == ["b"])
        picks.recent.set(["c", "d"])
        #expect(picks.agents.isEmpty)
        #expect(picks.recent.ids == ["c", "d"])
    }

    @Test func emptyingAListLeavesTheOthersAlone() {
        var picks = OverviewPicks()
        picks.recent.toggle("c")
        picks.agents.clear()
        #expect(picks.recent.ids == ["c"])
    }
}

@Suite struct RecentSweepTests {
    private func alerts() throws -> [AlertView] { try Fixture.snapshot().alerts }

    @Test func sweptAlertsLeaveAndUndoBringsThemBack() throws {
        let alerts = try alerts()
        var sweep = RecentSweep()
        sweep.sweep(alerts.prefix(2))
        #expect(alerts.map(sweep.contains) == [true, true, false, false, false])
        sweep.restore(alerts.prefix(1))
        #expect(alerts.map(sweep.contains) == [false, true, false, false, false])
    }

    @Test func anAlertThatEndsAnotherWayComesBack() throws {
        var alert = try #require(try alerts().first { $0.outcome.kind == .dismissed })
        var sweep = RecentSweep()
        sweep.sweep([alert])
        alert.outcome.kind = .session
        alert.sessionId = "ses_new"
        #expect(!sweep.contains(alert))
    }

    @Test func survivesItsDefaultsRoundTrip() throws {
        var sweep = RecentSweep()
        sweep.sweep(try alerts())
        #expect(RecentSweep(rawValue: sweep.rawValue) == sweep)
        #expect(RecentSweep(rawValue: "") == RecentSweep())
    }

    @Test func forgetsAlertsTheDaemonNoLongerLists() throws {
        let alerts = try alerts()
        var sweep = RecentSweep()
        sweep.sweep(alerts)
        sweep.keep(only: alerts.suffix(1))
        #expect(alerts.map(sweep.contains) == [false, false, false, false, true])
    }
}

@Suite struct InFlightSessionsTests {
    /// The daemon lists active sessions by their last update; the board keeps them where
    /// they started, so a step taken never moves a row.
    @Test func newestStartedFirstWhateverWasUpdatedLast() throws {
        var snap = try Fixture.snapshot()
        let base = try #require(snap.session(id: "ses_running"))
        func session(_ id: String, startedMinutesAgo: Double, updatedMinutesAgo: Double) -> Session {
            var s = base
            s.id = id
            s.startedAt = base.startedAt.addingTimeInterval(-startedMinutesAgo * 60)
            s.updatedAt = base.startedAt.addingTimeInterval(-updatedMinutesAgo * 60)
            return s
        }
        snap.actions = []
        snap.sessions = [
            session("old", startedMinutesAgo: 30, updatedMinutesAgo: 0),
            session("new", startedMinutesAgo: 5, updatedMinutesAgo: 4),
            session("mid", startedMinutesAgo: 10, updatedMinutesAgo: 1),
        ]
        #expect(snap.inFlightSessions.map(\.id) == ["new", "mid", "old"])
    }
}

@Suite struct BulkLabelTests {
    @Test func theHeaderSaysHowManySoTheVerbStandsAlone() {
        var s = RowSelection()
        s.set(["a", "b", "c"])
        #expect(s.label("Clear", acting: 3) == "Clear")
        #expect(s.label("Stop", acting: 3, asks: true) == "Stop…")
    }

    @Test func anActionOnSomeOfThePickedRowsSaysHowMany() {
        var s = RowSelection()
        s.set(["a", "b", "c"])
        #expect(s.label("Investigate", acting: 1) == "Investigate 1")
        #expect(s.label("Close", acting: 2, asks: true) == "Close 2…")
    }
}
