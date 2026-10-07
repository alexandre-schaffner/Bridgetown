import Foundation
import Testing
@testable import Bridgetown

@Suite struct AlertDetailRefreshTests {
    private let alertId = "C0AUK4AUER0:1790930000.000100"

    @Test func followsTheLiveSessionAndCards() throws {
        let snapshot = try Fixture.snapshot()
        let key = AlertDetailView.RefreshKey(snapshot: snapshot, alertId: alertId)
        #expect(key.sessionUpdatedAt == snapshot.session(id: "ses_closed")?.updatedAt)
        #expect(key.actionIds == ["act_review_1"])

        var updated = snapshot
        let index = try #require(updated.sessions.firstIndex { $0.id == "ses_closed" })
        updated.sessions[index].updatedAt.addTimeInterval(60)
        #expect(AlertDetailView.RefreshKey(snapshot: updated, alertId: alertId) != key)

        var dismissed = snapshot
        dismissed.actions.removeAll { $0.id == "act_review_1" }
        #expect(AlertDetailView.RefreshKey(snapshot: dismissed, alertId: alertId) != key)
    }

    /// The fetch fills in a session that has aged out of the snapshot. Keyed on it, the
    /// first load would change the key and fetch the alert a second time.
    @Test func aSessionGoneFromTheSnapshotIsNotPartOfTheKey() throws {
        var snapshot = try Fixture.snapshot()
        snapshot.sessions.removeAll { $0.id == "ses_closed" }
        #expect(AlertDetailView.RefreshKey(snapshot: snapshot, alertId: alertId).sessionUpdatedAt == nil)
    }
}

@Suite struct AlertOutcomeTitleTests {
    /// Only an alert nothing is left open on has "ended".
    @Test func anAlertIsOpenWhileACardOrAnAgentIsOnIt() throws {
        let snapshot = try Fixture.snapshot()
        var alert = try #require(snapshot.alert(id: "C0AUK4AUER0:1790930000.000100"))
        let closed = try #require(snapshot.session(id: "ses_closed"))
        let card = try #require(snapshot.actions.first { $0.id == "act_review_1" })

        alert.outcome.kind = .session
        #expect(!AlertDetailView.isOpen(alert, session: closed, openActions: []))
        #expect(AlertDetailView.isOpen(alert, session: closed, openActions: [card]))
        var running = closed
        running.status = .running
        #expect(AlertDetailView.isOpen(alert, session: running, openActions: []))
        alert.outcome.kind = .waiting
        #expect(AlertDetailView.isOpen(alert, session: nil, openActions: []))
        alert.outcome.kind = .dismissed
        #expect(!AlertDetailView.isOpen(alert, session: nil, openActions: []))
    }
}

@Suite struct ProseLinkTests {
    /// Prose links are drawn in the text's colour, so the underline is what marks them.
    @Test func onlyLinksAreUnderlined() throws {
        let text = Markdown.inline("See [the runbook](https://example.com/runbook) first", size: 12).underliningLinks()
        let underlined = text.runs.filter { $0.underlineStyle != nil }.map { String(text[$0.range].characters) }
        #expect(underlined == ["the runbook"])
    }
}
