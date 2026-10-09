import Foundation
import Testing
import UserNotifications
@testable import Bridgetown

@MainActor @Suite struct NotifierTests {
    /// Notification Center that answers `delivered` only once the test says so, with what it
    /// shows by then.
    final class Shelf: NotificationShelf {
        private(set) var shown: [String] = []
        private(set) var asked = 0
        var authorized = true
        private var waiting: [CheckedContinuation<Void, Never>] = []

        func post(_ request: UNNotificationRequest) { shown.append(request.identifier) }

        func delivered() async -> [String] {
            asked += 1
            await withCheckedContinuation { waiting.append($0) }
            return shown
        }

        func remove(_ identifiers: [String]) { shown.removeAll { identifiers.contains($0) } }

        func isAuthorized() async -> Bool { authorized }

        /// Once `count` callers wait on `delivered`, answers them all and lets them finish.
        func answer(_ count: Int) async {
            for _ in 0..<1_000 where waiting.count < count { await Task.yield() }
            #expect(waiting.count == count)
            let answers = waiting
            waiting = []
            answers.forEach { $0.resume() }
            for _ in 0..<10 { await Task.yield() }
        }
    }

    private func action(_ id: String) throws -> Action {
        var action = try #require(Fixture.snapshot().actions.first)
        action.id = id
        return action
    }

    @Test func theNotificationsOfActionsGoneAreTakenBack() async throws {
        let shelf = Shelf()
        let notifier = Notifier(center: shelf)
        notifier.post([try action("a"), try action("b")])
        notifier.withdraw(allBut: ["b"])
        await shelf.answer(1)
        #expect(shelf.shown == ["action-b"])
        notifier.withdraw(allBut: ["b"])
        #expect(shelf.asked == 1)
    }

    private func defaults() -> UserDefaults {
        let name = "bridgetown.tests.notifier.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private func settle() async {
        for _ in 0..<100 { await Task.yield() }
    }

    @Test func aNewerReleaseIsAnnouncedOncePerVersionAcrossLaunches() async {
        let defaults = defaults()
        let shelf = Shelf()
        let first = Notifier(center: shelf, defaults: defaults)
        first.post(update: .sample("1.2.0"))
        await settle()
        first.post(update: .sample("1.2.0"))
        await settle()
        #expect(shelf.shown == ["update"])

        shelf.remove(["update"])
        let relaunched = Notifier(center: shelf, defaults: defaults)
        relaunched.post(update: .sample("1.2.0"))
        await settle()
        #expect(shelf.shown.isEmpty)
        relaunched.post(update: .sample("1.3.0"))
        await settle()
        #expect(shelf.shown == ["update"])
    }

    /// Posted before you allow notifications, it would be dropped: it waits for a check
    /// after you have.
    @Test func aReleaseIsntCountedAnnouncedUntilNotificationsAreAllowed() async {
        let shelf = Shelf()
        shelf.authorized = false
        let notifier = Notifier(center: shelf, defaults: defaults())
        notifier.post(update: .sample("1.2.0"))
        await settle()
        #expect(shelf.shown.isEmpty)
        shelf.authorized = true
        notifier.post(update: .sample("1.2.0"))
        await settle()
        #expect(shelf.shown == ["update"])
    }

    /// Taking back the cards gone leaves the update's notification alone.
    @Test func takingBackActionsLeavesTheUpdateAlone() async throws {
        let shelf = Shelf()
        let notifier = Notifier(center: shelf, defaults: defaults())
        notifier.post(update: .sample("1.2.0"))
        await settle()
        notifier.post([try action("a")])
        notifier.withdraw(allBut: [])
        await shelf.answer(1)
        #expect(shelf.shown == ["update"])
    }

    /// A card that comes up while Notification Center is asked what it shows is posted
    /// before the answer is in, and must not be taken back with the ones gone.
    @Test func aCardPostedWhileTheOldOnesAreTakenBackStays() async throws {
        let shelf = Shelf()
        let notifier = Notifier(center: shelf)
        notifier.post([try action("a"), try action("b")])
        notifier.withdraw(allBut: ["b"])
        notifier.withdraw(allBut: ["b", "c"])
        notifier.post([try action("c")])
        await shelf.answer(2)
        #expect(shelf.shown == ["action-b", "action-c"])
    }
}

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
