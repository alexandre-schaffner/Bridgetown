import AppKit
import Foundation
import Observation

/// Keeps Bridgetown current from its GitHub releases: it asks for the latest release at
/// launch and every few hours, says when a newer one is out (`onAvailable`, a notification
/// once per version), and installs it in place when you ask (`UpdateInstaller`), then
/// relaunches.
///
/// Only a release build running from its .app checks: a debug binary has no version to
/// compare. One that can't replace itself (translocated, on a read-only volume, in a
/// folder you can't write to) still says an update is out, and offers the download.
@MainActor
@Observable
final class Updater {
    enum State: Equatable {
        /// Nothing newer known: not checked yet, or checked on its own and nothing came.
        case idle
        /// Checking because you asked.
        case checking
        /// Checked because you asked, and this is the newest. Clears after a few seconds.
        case upToDate
        case available(Release)
        case downloading(Release, percent: Int)
        /// Downloaded: checking it, swapping it in and relaunching.
        case installing(Release)
        /// In place, but Bridgetown couldn't open it: quitting and opening it again does.
        case installed(Release)
        /// Why the last check you asked for failed.
        case checkFailed(String)
        /// Why installing this release failed; it may be tried again.
        case installFailed(Release, String)

        /// The newer release this state is about, if any.
        var release: Release? {
            switch self {
            case let .available(r), let .downloading(r, _), let .installing(r), let .installed(r), let .installFailed(r, _): r
            case .idle, .checking, .upToDate, .checkFailed: nil
            }
        }

        /// Whether a check or an install is under way, or done with but for the relaunch.
        var isBusy: Bool {
            switch self {
            case .checking, .downloading, .installing, .installed: true
            default: false
            }
        }
    }

    /// What the update control does now: the notice's button and the menu's item.
    enum Action: Equatable {
        case check
        case install(Release)
        /// The DMG, for an app that can't replace itself.
        case download(Release)
        /// Relaunch by hand, onto the release installed.
        case quit

        /// As the menu says it.
        var title: String {
            switch self {
            case .check: "Check for updates"
            case let .install(r): "Install Bridgetown \(r.version)"
            case let .download(r): "Download Bridgetown \(r.version)"
            case .quit: "Quit to finish updating"
            }
        }
    }

    typealias Feed = @Sendable () async throws -> Release

    static let interval: Duration = .seconds(6 * 3600)
    /// The install this launch may be the end of (`Pending`).
    private static let pendingKey = "updatePending"

    /// What an install leaves for the next launch: where the old app waits, and the release
    /// that should be running.
    private struct Pending: Codable {
        let work: String
        let release: Release
    }

    /// This app's version; nil for a debug binary.
    let current: AppVersion?
    /// What replaces this app, or why nothing can.
    let installer: Result<UpdateInstaller, UpdateError>
    private(set) var state = State.idle
    /// Called each time a check finds a newer release.
    @ObservationIgnored var onAvailable: ((Release) -> Void)?

    @ObservationIgnored private let feed: Feed
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var clearTask: Task<Void, Never>?

    /// This app, as its bundle says.
    convenience init(bundle: Bundle = .main) {
        let isApp = bundle.bundleIdentifier != nil && bundle.bundleURL.pathExtension == "app"
        self.init(
            current: isApp ? (bundle.infoDictionary?["CFBundleShortVersionString"] as? String).flatMap(AppVersion.init) : nil,
            installer: UpdateInstaller.of(bundle)
        )
    }

    init(
        current: AppVersion?,
        installer: Result<UpdateInstaller, UpdateError>,
        defaults: UserDefaults = .standard,
        feed: @escaping Feed = { try await GitHubReleases.latest() }
    ) {
        self.current = current
        self.installer = installer
        self.feed = feed
        self.defaults = defaults
    }

    /// Whether it checks at all: a release build, from its .app.
    var isEnabled: Bool { current != nil }

    /// Whether an update installs here, or has to be downloaded.
    var canInstall: Bool { (try? installer.get()) != nil }

    var action: Action? {
        switch state {
        case .idle, .upToDate, .checkFailed: .check
        case let .available(r), let .installFailed(r, _): canInstall ? .install(r) : .download(r)
        case .installed: .quit
        case .checking, .downloading, .installing: nil
        }
    }

    func perform(_ action: Action) {
        switch action {
        case .check: Task { await check(manual: true) }
        case let .install(r): install(r)
        case let .download(r): SystemActions.open(r.dmg.absoluteString)
        case .quit: SystemActions.quit()
        }
    }

    /// Finishes the install this launch may be the end of, then checks now and every
    /// `interval`.
    func start() {
        guard isEnabled, loop == nil else { return }
        loop = Task { [weak self] in
            await self?.finishInstall()
            while !Task.isCancelled {
                await self?.check(manual: false)
                try? await Task.sleep(for: Self.interval)
            }
        }
    }

    /// Asks GitHub for the latest release. One you asked for says how it went; one on its
    /// own only speaks up when there is something newer.
    func check(manual: Bool) async {
        guard let current, !state.isBusy else { return }
        clearTask?.cancel()
        if manual { state = .checking }
        do {
            let latest = try await feed()
            // An install may have started while the check was out.
            guard !state.isBusy || state == .checking else { return }
            if latest.version > current {
                // On its own, a check leaves up why this release didn't install.
                if !manual, case let .installFailed(failed, _) = state, failed == latest { return }
                state = .available(latest)
                onAvailable?(latest)
            } else if manual {
                state = .upToDate
                clearTask = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(5))
                    guard !Task.isCancelled, let self, self.state == .upToDate else { return }
                    self.state = .idle
                }
            } else {
                state = .idle
            }
        } catch {
            if manual { state = .checkFailed(error.userMessage(peer: "GitHub")) }
        }
    }

    /// Downloads `release`, checks it, swaps it in for this app and relaunches.
    func install(_ release: Release) {
        guard !state.isBusy, case let .success(installer) = installer else { return }
        #if DEBUG
        if let sink = SystemActions.sink { return sink(.installUpdate, release.version.description) }
        #endif
        state = .downloading(release, percent: 0)
        Task {
            let work: URL
            do {
                work = try await installer.install(release) { percent in
                    Task { @MainActor in self.downloaded(release, percent) }
                }
            } catch {
                state = .installFailed(release, error.userMessage(peer: "GitHub"))
                return
            }
            // In place from here on: whichever app opens next removes the old one.
            if let pending = try? JSONEncoder().encode(Pending(work: work.path, release: release)) {
                defaults.set(pending, forKey: Self.pendingKey)
            }
            do {
                try UpdateInstaller.relaunch(installer.destination, keptIn: work)
                NSApp.terminate(nil)
            } catch {
                state = .installed(release)
            }
        }
    }

    /// The download's progress, which may come after it is over, or out of order.
    private func downloaded(_ release: Release, _ percent: Int) {
        guard case let .downloading(r, was) = state, r == release, percent > was else { return }
        state = percent < 100 ? .downloading(release, percent: percent) : .installing(release)
    }

    /// After an install: the old app goes. Still this old, the new one didn't open, and
    /// `relaunch` put this one back.
    private func finishInstall() async {
        guard let data = defaults.data(forKey: Self.pendingKey) else { return }
        defaults.removeObject(forKey: Self.pendingKey)
        guard let pending = try? JSONDecoder().decode(Pending.self, from: data) else { return }
        if let current, current < pending.release.version {
            state = .installFailed(pending.release, "Bridgetown \(pending.release.version) didn't open, so \(current) is back")
        }
        await UpdateInstaller.discard(URL(fileURLWithPath: pending.work))
    }

    #if DEBUG
    /// An e2e run's `update` step: the notice in `state`.
    func preview(_ state: State) {
        self.state = state
    }
    #endif
}
