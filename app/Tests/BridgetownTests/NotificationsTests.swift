import Foundation
import Testing
@testable import Bridgetown

@Suite struct NewActionsTests {
    @Test func theFirstSnapshotIsTheBaselineThenOnlyNewIdsCount() throws {
        var snap = try Fixture.snapshot()
        snap.settings.quietHours.enabled = false
        var new = NewActions()
        #expect(new.update(snap).isEmpty)
        #expect(new.update(snap).isEmpty)

        var fresh = try #require(snap.actions.first)
        fresh.id = "act_fresh"
        snap.actions.append(fresh)
        #expect(new.update(snap).map(\.id) == ["act_fresh"])
        #expect(new.update(snap).isEmpty)
    }

    /// It keeps the cards standing and no more, so it doesn't grow for as long as the app
    /// runs; the ones gone are the notifications to take back.
    @Test func itRemembersOnlyTheCardsStanding() throws {
        var snap = try Fixture.snapshot()
        snap.settings.quietHours.enabled = false
        var new = NewActions()
        _ = new.update(snap)
        let resolved = try #require(snap.actions.first)
        snap.actions.removeFirst()
        _ = new.update(snap)
        #expect(new.seen == Set(snap.actions.map(\.id)))
        #expect(new.seen?.contains(resolved.id) == false)
    }

    @Test func quietHoursHoldThemBackButStillCountThemSeen() throws {
        var snap = try Fixture.snapshot()
        snap.settings.quietHours = .init(enabled: true, start: "00:00", end: "23:59")
        var new = NewActions()
        _ = new.update(snap)
        var fresh = try #require(snap.actions.first)
        fresh.id = "act_quiet"
        snap.actions.append(fresh)
        #expect(new.update(snap, now: Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: .now)!).isEmpty)
        snap.settings.quietHours.enabled = false
        #expect(new.update(snap).isEmpty)
    }
}

@Suite struct QuietHoursTests {
    private func at(_ hour: Int, _ minute: Int) -> Date {
        var c = DateComponents()
        c.year = 2026; c.month = 10; c.day = 3; c.hour = hour; c.minute = minute
        return Calendar(identifier: .gregorian).date(from: c)!
    }

    private let calendar = Calendar(identifier: .gregorian)

    @Test func wrapsMidnight() {
        let q = Settings.QuietHours(enabled: true, start: "22:00", end: "08:00")
        #expect(QuietHours.isActive(q, at: at(23, 30), calendar: calendar))
        #expect(QuietHours.isActive(q, at: at(7, 59), calendar: calendar))
        #expect(!QuietHours.isActive(q, at: at(8, 0), calendar: calendar))
        #expect(!QuietHours.isActive(q, at: at(12, 0), calendar: calendar))
    }

    @Test func sameDayWindow() {
        let q = Settings.QuietHours(enabled: true, start: "12:00", end: "13:30")
        #expect(QuietHours.isActive(q, at: at(12, 0), calendar: calendar))
        #expect(!QuietHours.isActive(q, at: at(13, 30), calendar: calendar))
    }

    @Test func disabledEmptyOrMalformedIsNeverActive() {
        #expect(!QuietHours.isActive(.init(enabled: false, start: "00:00", end: "23:59"), at: at(12, 0), calendar: calendar))
        #expect(!QuietHours.isActive(.init(enabled: true, start: "09:00", end: "09:00"), at: at(9, 0), calendar: calendar))
        #expect(!QuietHours.isActive(.init(enabled: true, start: "25:00", end: "08:00"), at: at(3, 0), calendar: calendar))
        #expect(QuietHours.minutes("7:05") == 425)
        #expect(QuietHours.minutes("07:60") == nil)
    }
}
