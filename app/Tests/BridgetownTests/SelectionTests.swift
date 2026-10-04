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
