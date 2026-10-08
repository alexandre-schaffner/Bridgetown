import AppKit
import Foundation
import Observation

/// Keeps Bridgetown current from its GitHub releases: it asks for the latest release at
/// launch and every few hours, says once per version that a newer one is out (`onAvailable`,
/// a notification), and installs it in place when you ask (`UpdateInstaller`), then
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
        case downloading(Release, progress: Double)
        /// Downloaded and checked; swapping the app and relaunching.
        case installing(Release)
        /// Why the last check you asked for or the last install failed. With a release,
        /// installing it may be tried again.
        case failed(String, Release?)

        /// The newer release this state is about, if any.
        var release: Release? {
            switch self {
            case let .available(r), let .downloading(r, _), let .installing(r): r
            case let .failed(_, r): r
            case .idle, .checking, .upToDate: nil
            }
        }

        var isBusy: Bool {
            switch self {
            case .checking, .downloading, .installing: true
            default: false
            }
        }
    }

    typealias Feed = @Sendable () async throws -> Release

    nonisolated static let repository = "alexandre-schaffner/Bridgetown"
    static let interval: Duration = .seconds(6 * 3600)
    /// The last version announced, so a relaunch doesn't announce it again.
    private static let announcedKey = "updateAnnounced"

    /// This app's version; nil for a debug binary.
    let current: AppVersion?
    /// The bundle an install replaces; nil when this app can't replace itself.
    let destination: URL?
    private(set) var state = State.idle
    /// Called once per newer version, the first time a check finds it.
    @ObservationIgnored var onAvailable: ((Release) -> Void)?

    @ObservationIgnored private let feed: Feed
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var clearTask: Task<Void, Never>?

    #if DEBUG
    /// Set by an e2e run's `update` step: the install button shows, and does nothing.
    @ObservationIgnored private var previewing = false
    #endif

    /// This app, as its bundle says.
    convenience init(bundle: Bundle = .main) {
        let isApp = bundle.bundleIdentifier != nil && bundle.bundleURL.pathExtension == "app"
        self.init(
            current: isApp ? (bundle.infoDictionary?["CFBundleShortVersionString"] as? String).flatMap(AppVersion.init) : nil,
            destination: isApp && UpdateInstaller.canReplace(bundle.bundleURL) ? bundle.bundleURL : nil
        )
    }

    init(
        current: AppVersion?,
        destination: URL?,
        defaults: UserDefaults = .standard,
        feed: @escaping Feed = { try await Release.latest(repository: Updater.repository) }
    ) {
        self.current = current
        self.destination = destination
        self.feed = feed
        self.defaults = defaults
    }

    /// Whether it checks at all: a release build, from its .app.
    var isEnabled: Bool { current != nil }

    /// Whether an update installs here, or has to be downloaded.
    var canInstall: Bool {
        #if DEBUG
        if previewing { return true }
        #endif
        return destination != nil
    }

    /// Checks now, then every `interval`.
    func start() {
        guard isEnabled, loop == nil else { return }
        loop = Task { [weak self] in
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
                state = .available(latest)
                announce(latest)
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
            if manual { state = .failed(Self.message(error), nil) }
        }
    }

    /// Downloads the newer release, checks it, swaps it in for this app and relaunches.
    func install() {
        guard let release = state.release, !state.isBusy else { return }
        guard let destination, let identifier = Bundle.main.bundleIdentifier else { return }
        state = .downloading(release, progress: 0)
        Task {
            do {
                let installer = UpdateInstaller(destination: destination, bundleIdentifier: identifier)
                let leftover = try await installer.install(release) { fraction in
                    Task { @MainActor in
                        guard case .downloading = self.state else { return }
                        self.state = fraction < 1 ? .downloading(release, progress: fraction) : .installing(release)
                    }
                }
                state = .installing(release)
                try UpdateInstaller.relaunch(destination, removing: leftover)
                NSApp.terminate(nil)
            } catch {
                state = .failed(Self.message(error), release)
            }
        }
    }

    private func announce(_ release: Release) {
        guard defaults.string(forKey: Self.announcedKey) != release.version.description else { return }
        defaults.set(release.version.description, forKey: Self.announcedKey)
        onAvailable?(release)
    }

    nonisolated static func message(_ error: Error) -> String {
        if let error = error as? UpdateError { return error.message }
        if let error = error as? URLError {
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost:
                return "GitHub isn't reachable"
            case .timedOut: return "GitHub timed out"
            default: break
            }
        }
        return error.localizedDescription
    }

    #if DEBUG
    /// An e2e run's `update` step: the notice in `state`, with a made-up release.
    func preview(_ state: State) {
        previewing = true
        self.state = state
    }
    #endif
}

/// A version as releases are tagged: "1.2.0", or "v1.2.0". Anything else (a prerelease's
/// "1.2.0-beta.1") isn't one.
struct AppVersion: Comparable, CustomStringConvertible, Sendable {
    let parts: [Int]

    init?(_ string: String) {
        let numbers = (string.hasPrefix("v") ? String(string.dropFirst()) : string)
            .split(separator: ".", omittingEmptySubsequences: false)
            .map { $0.allSatisfy { $0.isASCII && $0.isNumber } ? Int($0) : nil }
        guard !numbers.isEmpty, numbers.allSatisfy({ ($0 ?? -1) >= 0 }) else { return nil }
        parts = numbers.compactMap { $0 }
    }

    var description: String { parts.map(String.init).joined(separator: ".") }

    /// 1.2 and 1.2.0 are the same version.
    private func part(_ i: Int) -> Int { i < parts.count ? parts[i] : 0 }

    static func == (a: Self, b: Self) -> Bool {
        (0..<max(a.parts.count, b.parts.count)).allSatisfy { a.part($0) == b.part($0) }
    }

    static func < (a: Self, b: Self) -> Bool {
        for i in 0..<max(a.parts.count, b.parts.count) where a.part(i) != b.part(i) {
            return a.part(i) < b.part(i)
        }
        return false
    }
}

/// The latest published release, as GitHub's `releases/latest` lists it: drafts and
/// prereleases never are.
struct Release: Equatable, Sendable {
    /// The asset `make dmg` builds and the release workflow uploads.
    static let dmgName = "Bridgetown.dmg"

    let version: AppVersion
    /// The release page: its notes, and the way to install by hand.
    let page: URL
    let dmg: URL
    /// The DMG's SHA-256, lowercase hex, as GitHub computed it on upload.
    let sha256: String

    init(version: AppVersion, page: URL, dmg: URL, sha256: String) {
        self.version = version
        self.page = page
        self.dmg = dmg
        self.sha256 = sha256
    }

    /// Reads GitHub's release JSON. A release without the DMG, or without its digest,
    /// isn't one to install.
    init(json data: Data) throws {
        struct Payload: Decodable {
            struct Asset: Decodable {
                let name: String
                let browser_download_url: URL
                let digest: String?
            }
            let tag_name: String
            let html_url: URL
            let assets: [Asset]
        }
        let payload: Payload
        do {
            payload = try JSONDecoder().decode(Payload.self, from: data)
        } catch {
            throw UpdateError("Couldn't read GitHub's answer")
        }
        guard let version = AppVersion(payload.tag_name) else { throw UpdateError("The latest release, \(payload.tag_name), isn't a version") }
        guard let asset = payload.assets.first(where: { $0.name == Self.dmgName }) else {
            throw UpdateError("Bridgetown \(version) has no \(Self.dmgName) yet")
        }
        guard let digest = asset.digest, digest.hasPrefix("sha256:") else {
            throw UpdateError("Bridgetown \(version) has no checksum for its download")
        }
        self.init(version: version, page: payload.html_url, dmg: asset.browser_download_url, sha256: String(digest.dropFirst(7)).lowercased())
    }

    /// The latest release of `repository`, from GitHub's API (unauthenticated: 60 an hour
    /// is plenty for a check every few hours).
    nonisolated static func latest(repository: String, session: URLSession = .shared) async throws -> Release {
        var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(repository)/releases/latest")!)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw UpdateError(status == 404 ? "No release published yet" : "GitHub answered \(status)") }
        return try Release(json: data)
    }
}

struct UpdateError: Error, Equatable {
    let message: String

    init(_ message: String) { self.message = message }
}
