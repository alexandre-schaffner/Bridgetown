import Foundation
import os
import Testing
@testable import Bridgetown

@Suite struct AppVersionTests {
    @Test func readsTagsAndOrdersByNumberNotText() throws {
        let v = try #require(AppVersion("v1.10.0"))
        #expect(v.description == "1.10.0")
        #expect(try #require(AppVersion("1.9.3")) < v)
        #expect(AppVersion("1.2") == AppVersion("1.2.0"))
        #expect(try #require(AppVersion("2.0.0")) > v)
    }

    @Test func aPrereleaseOrAnythingElseIsNotAVersion() {
        for text in ["1.2.0-beta.1", "", "v", "1..2", "1.x", "+1.2", "nightly"] {
            #expect(AppVersion(text) == nil, "\(text)")
        }
    }
}

@Suite struct ReleaseTests {
    static func json(tag: String = "v1.2.0", assets: String? = nil) -> Data {
        let assets = assets ?? """
        [{"name": "SHA256SUMS", "browser_download_url": "https://example.com/SHA256SUMS", "digest": "sha256:00"},
         {"name": "Bridgetown.dmg", "browser_download_url": "https://example.com/Bridgetown.dmg", "digest": "sha256:ABCDEF"}]
        """
        return Data("""
        {"tag_name": "\(tag)", "html_url": "https://github.com/o/r/releases/tag/\(tag)", "draft": false, "assets": \(assets)}
        """.utf8)
    }

    @Test func readsTheDMGAndItsDigest() throws {
        let release = try Release(json: Self.json())
        #expect(release.version == AppVersion("1.2.0"))
        #expect(release.dmg.absoluteString == "https://example.com/Bridgetown.dmg")
        #expect(release.page.absoluteString == "https://github.com/o/r/releases/tag/v1.2.0")
        #expect(release.sha256 == "abcdef")
    }

    @Test func aReleaseWithoutTheDMGOrItsDigestIsNotOneToInstall() {
        #expect(throws: UpdateError("Bridgetown 1.2.0 has no Bridgetown.dmg yet")) {
            try Release(json: Self.json(assets: "[]"))
        }
        #expect(throws: UpdateError("Bridgetown 1.2.0 has no checksum for its download")) {
            try Release(json: Self.json(assets: #"[{"name": "Bridgetown.dmg", "browser_download_url": "https://example.com/d"}]"#))
        }
        #expect(throws: UpdateError("The latest release, v2-rc, isn't a version")) {
            try Release(json: Self.json(tag: "v2-rc"))
        }
    }
}

@MainActor @Suite struct UpdaterTests {
    nonisolated static let release = Release.sample("1.2.0")

    private func defaults() -> UserDefaults {
        let name = "bridgetown.tests.updater.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private func updater(
        _ current: String?, installs: Bool = false, defaults: UserDefaults? = nil,
        feed: @escaping Updater.Feed = { UpdaterTests.release }
    ) -> Updater {
        let installer = UpdateInstaller(destination: URL(fileURLWithPath: "/Applications/Bridgetown.app"), bundleIdentifier: "xyz.merkl.bridgetown")
        return Updater(
            current: current.flatMap(AppVersion.init),
            installer: installs ? .success(installer) : .failure(UpdateError("Move Bridgetown to Applications to update it from here.")),
            defaults: defaults ?? self.defaults(), feed: feed
        )
    }

    /// Each check that finds it says so; the notifier says it once (NotifierTests).
    @Test func everyCheckThatFindsANewerReleaseSaysSo() async {
        var found: [String] = []
        let updater = updater("1.1.0")
        updater.onAvailable = { found.append($0.version.description) }
        await updater.check(manual: false)
        await updater.check(manual: false)
        #expect(updater.state == .available(Self.release))
        #expect(found == ["1.2.0", "1.2.0"])
    }

    @Test func onlyACheckYouAskedForSaysThereIsNothingNewer() async {
        let latest = updater("1.2.0")
        await latest.check(manual: false)
        #expect(latest.state == .idle)
        await latest.check(manual: true)
        #expect(latest.state == .upToDate)
    }

    @Test func onlyACheckYouAskedForSaysItFailed() async {
        let offline = updater("1.1.0") { throw URLError(.notConnectedToInternet) }
        await offline.check(manual: false)
        #expect(offline.state == .idle)
        await offline.check(manual: true)
        #expect(offline.state == .checkFailed("GitHub not reachable"))
        #expect(offline.action == .check)
    }

    @Test func aDebugBinaryNeverChecks() async {
        let debug = updater(nil) {
            Issue.record("checked")
            return UpdaterTests.release
        }
        #expect(!debug.isEnabled)
        await debug.check(manual: true)
        #expect(debug.state == .idle)
    }

    /// The notice's button and the menu's item are the same action.
    @Test func aNewerReleaseInstallsHereOrIsDownloaded() async {
        let here = updater("1.1.0", installs: true)
        await here.check(manual: false)
        #expect(here.action == .install(Self.release))

        let elsewhere = updater("1.1.0")
        await elsewhere.check(manual: false)
        #expect(elsewhere.action == .download(Self.release))
    }

    /// Relaunched onto the old version: the new one didn't open, and the relaunch put this
    /// one back. That stays up through the next check, and the old app's folder goes.
    @Test func aLaunchStillOnTheOldVersionSaysTheInstallDidntTake() async throws {
        let defaults = defaults()
        let work = FileManager.default.temporaryDirectory.appending(path: "bt-update-work-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: work.appending(path: "Failed.app"), withIntermediateDirectories: true)
        struct Pending: Encodable { let work: String; let release: Release }
        defaults.set(try JSONEncoder().encode(Pending(work: work.path, release: Self.release)), forKey: "updatePending")

        let updater = updater("1.1.0", installs: true, defaults: defaults)
        updater.start()
        for _ in 0..<1_000 where FileManager.default.fileExists(atPath: work.path) { await Task.yield() }
        for _ in 0..<100 { await Task.yield() }
        #expect(updater.state == .installFailed(Self.release, "Bridgetown 1.2.0 didn't open, so 1.1.0 is back"))
        #expect(updater.action == .install(Self.release))
        #expect(!FileManager.default.fileExists(atPath: work.path))
        #expect(defaults.data(forKey: "updatePending") == nil)
    }
}

/// The installer against real bundles and disk images: a minimal signed app, built into a
/// DMG and served over loopback. One at a time: hdiutil run alongside itself is now and
/// then "Resource busy".
@MainActor @Suite(.serialized) struct UpdateInstallerTests {
    static let identifier = "xyz.merkl.bridgetown.tests"

    private let root = FileManager.default.temporaryDirectory.appending(path: "bt-update-tests-\(UUID().uuidString)")

    /// A signed Bridgetown.app saying `version`, with `/usr/bin/true` for its executable.
    private func app(_ version: String, in dir: String, identifier: String = identifier) async throws -> URL {
        let app = root.appending(path: dir).appending(path: "Bridgetown.app")
        let contents = app.appending(path: "Contents")
        try FileManager.default.createDirectory(at: contents.appending(path: "MacOS"), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: contents.appending(path: "MacOS/Bridgetown"))
        let info: [String: Any] = [
            "CFBundleIdentifier": identifier, "CFBundleShortVersionString": version,
            "CFBundleExecutable": "Bridgetown", "CFBundlePackageType": "APPL",
        ]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: contents.appending(path: "Info.plist"))
        try await UpdateInstaller.run("/usr/bin/codesign", ["--force", "-s", "-", app.path], failure: "codesign")
        return app
    }

    /// The image `make dmg` would build around `app`.
    private func dmg(_ app: URL) async throws -> URL {
        let dmg = app.deletingLastPathComponent().appending(path: "Bridgetown.dmg")
        try await UpdateInstaller.run("/usr/bin/hdiutil", ["create", "-quiet", "-volname", "Bridgetown", "-srcfolder", app.path, "-format", "UDZO", "-ov", dmg.path], failure: "hdiutil create", attempts: 3)
        return dmg
    }

    private func version(_ app: URL) -> String? {
        NSDictionary(contentsOf: app.appending(path: "Contents/Info.plist"))?["CFBundleShortVersionString"] as? String
    }

    @Test func installSwapsTheNewAppInAndKeepsTheOldAside() async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let installed = try await app("1.1.0", in: "Applications")
        let image = try await dmg(try await app("1.2.0", in: "build"))
        let bytes = try Data(contentsOf: image)
        let stub = try StubDaemon(snapshot: Data("{}".utf8)) { _ in .init(body: bytes) }
        let endpoint = try await stub.start()
        defer { stub.stop() }

        let release = Release.sample("1.2.0", dmg: URL(string: "http://127.0.0.1:\(endpoint.port)/Bridgetown.dmg")!, sha256: try UpdateInstaller.sha256(of: image))
        let progress = OSAllocatedUnfairLock(initialState: [Int]())
        let work = try await UpdateInstaller(destination: installed, bundleIdentifier: Self.identifier)
            .install(release) { percent in progress.withLock { $0.append(percent) } }

        #expect(version(installed) == "1.2.0")
        #expect(version(work.appending(path: UpdateInstaller.previous)) == "1.1.0")
        // Rising, in whole percents, and 100 only once the file is in place.
        let percents = progress.withLock { $0 }
        #expect(percents.last == 100)
        #expect(percents == percents.sorted() && Set(percents).count == percents.count)
        #expect(!UpdateInstaller.isMountPoint(work.appending(path: "mount")))
        // Never quarantined, so the new app opens without Gatekeeper's prompt.
        let quarantined = getxattr(installed.path, "com.apple.quarantine", nil, 0, 0, 0) >= 0
        #expect(!quarantined)
        await UpdateInstaller.discard(work)
        #expect(!FileManager.default.fileExists(atPath: work.path))
    }

    @Test func aDownloadThatDoesntMatchItsChecksumIsRefused() async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let installed = try await app("1.1.0", in: "Applications")
        let stub = try StubDaemon(snapshot: Data("{}".utf8)) { _ in .init(body: Data("not a disk image".utf8)) }
        let endpoint = try await stub.start()
        defer { stub.stop() }

        let release = Release.sample("1.2.0", dmg: URL(string: "http://127.0.0.1:\(endpoint.port)/Bridgetown.dmg")!, sha256: String(repeating: "0", count: 64))
        await #expect(throws: UpdateError("The download doesn't match its checksum")) {
            _ = try await UpdateInstaller(destination: installed, bundleIdentifier: Self.identifier).install(release) { _ in }
        }
        #expect(version(installed) == "1.1.0")
    }

    enum Impostor: CaseIterable {
        case otherVersion, otherIdentifier, brokenSeal
    }

    @Test(arguments: Impostor.allCases)
    func anAppOfAnotherVersionOrIdentifierOrWithABrokenSealIsRefused(_ impostor: Impostor) async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = UpdateInstaller(destination: root.appending(path: "Applications/Bridgetown.app"), bundleIdentifier: Self.identifier)
        let app: URL
        let refusal: UpdateError
        switch impostor {
        case .otherVersion:
            app = try await self.app("1.3.0", in: "build")
            refusal = UpdateError("The download isn't Bridgetown 1.2.0")
        case .otherIdentifier:
            app = try await self.app("1.2.0", in: "build", identifier: "com.example.other")
            refusal = UpdateError("The download isn't Bridgetown")
        case .brokenSeal:
            app = try await self.app("1.2.0", in: "build")
            try Data("added after signing".utf8).write(to: app.appending(path: "Contents/Extra"))
            refusal = UpdateError("The new app's signature doesn't hold")
        }
        let image = try await dmg(app)
        let work = root.appending(path: "work")
        await #expect(throws: refusal) {
            _ = try await installer.stage(image, version: AppVersion("1.2.0")!, in: work)
        }
        #expect(!UpdateInstaller.isMountPoint(work.appending(path: "mount")))
    }

    /// An image still mounted in the work folder would keep it from being removed.
    @Test func discardingTheWorkFolderLetsGoOfItsImage() async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let image = try await dmg(try await app("1.2.0", in: "build"))
        let work = root.appending(path: "work")
        let mount = work.appending(path: "mount")
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
        try await UpdateInstaller.run("/usr/bin/hdiutil", ["attach", image.path, "-nobrowse", "-readonly", "-mountpoint", mount.path], failure: "attach", attempts: 3)
        let disk = try #require(UpdateInstaller.disk(mountedAt: mount))
        await UpdateInstaller.discard(work)
        #expect(!UpdateInstaller.isMountPoint(mount))
        #expect(!FileManager.default.fileExists(atPath: work.path))
        // The image itself, not only its volume.
        #expect(!FileManager.default.fileExists(atPath: disk))
    }

    @Test func aTranslocatedOrUnwritableAppSaysWhyItCantReplaceItself() throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let writable = root.appending(path: "Applications/Bridgetown.app")
        try FileManager.default.createDirectory(at: writable, withIntermediateDirectories: true)
        #expect(UpdateInstaller.obstacle(to: writable) == nil)
        #expect(UpdateInstaller.obstacle(to: URL(fileURLWithPath: "/private/var/folders/x/AppTranslocation/ABC/d/Bridgetown.app"))
            == UpdateError("Move Bridgetown to Applications to update it from here."))
        #expect(UpdateInstaller.obstacle(to: URL(fileURLWithPath: "/Volumes/Bridgetown/Bridgetown.app"))
            == UpdateError("Move Bridgetown to Applications to update it from here."))
        #expect(UpdateInstaller.obstacle(to: URL(fileURLWithPath: "/System/Applications/Bridgetown.app"))
            == UpdateError("You can't change apps in /System/Applications, so Bridgetown can't replace itself."))
    }
}
