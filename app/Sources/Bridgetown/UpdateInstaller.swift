import CryptoKit
import Foundation
import os

/// Puts a newer release in place of this app, the way you would by hand, with checks a
/// person skips:
///
/// 1. downloads the DMG next to the app (same volume, so the swap is two renames);
/// 2. checks its SHA-256 against the digest GitHub computed when the release workflow
///    uploaded it (releases are immutable once published);
/// 3. mounts it read-only and copies Bridgetown.app out, refusing a bundle with another
///    identifier, another version than the release's, or a signature that doesn't hold;
/// 4. swaps it in for the running app, putting the old one back if the second rename fails.
///
/// What this proves is that the app is the one GitHub lists for the release, intact. It
/// doesn't prove who built it: releases are signed ad hoc, so the signature only says the
/// bundle hasn't changed since it was signed.
///
/// `relaunch` then waits for this process to quit and opens the new app, which removes the
/// old one once it is up (`discard`); if it never comes up, the old one goes back. The
/// download is never quarantined (URLSession doesn't set the flag), so the new app opens
/// without Gatekeeper's "Open Anyway".
struct UpdateInstaller: Sendable {
    /// The app bundle to replace.
    let destination: URL
    /// What the new bundle must call itself.
    let bundleIdentifier: String

    private static let log = Logger(subsystem: "xyz.merkl.bridgetown", category: "update")

    /// The installer for the app in `bundle`, or why it can't replace itself.
    static func of(_ bundle: Bundle) -> Result<UpdateInstaller, UpdateError> {
        guard let identifier = bundle.bundleIdentifier, bundle.bundleURL.pathExtension == "app" else {
            return .failure(UpdateError("Bridgetown isn't running from its app"))
        }
        if let obstacle = obstacle(to: bundle.bundleURL) { return .failure(obstacle) }
        return .success(UpdateInstaller(destination: bundle.bundleURL, bundleIdentifier: identifier))
    }

    /// Why `bundle` can't be swapped for another, if it can't: translocated (run from where
    /// it was downloaded, on a read-only mirror), on a read-only volume, or in a folder you
    /// can't write to.
    static func obstacle(to bundle: URL) -> UpdateError? {
        let fm = FileManager.default
        let folder = bundle.deletingLastPathComponent()
        let translocated = bundle.path.contains("/AppTranslocation/")
        if !translocated, fm.isWritableFile(atPath: folder.path), fm.isWritableFile(atPath: bundle.path) { return nil }
        // Installed, but by someone else: moving it wouldn't help.
        if !translocated, folder.lastPathComponent == "Applications" {
            return UpdateError("You can't change apps in \(folder.path), so Bridgetown can't replace itself.")
        }
        return UpdateError("Move Bridgetown to Applications to update it from here.")
    }

    /// Installs `release` over `destination`. `progress` hears the download's percentage,
    /// rising, and 100 once it is all here. Returns the folder holding the old app, which the
    /// new app removes once it is up (`discard`).
    func install(_ release: Release, progress: @escaping @Sendable (Int) -> Void) async throws -> URL {
        let work: URL
        do {
            work = try FileManager.default.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: destination, create: true)
        } catch {
            throw UpdateError("Couldn't make room next to \(destination.lastPathComponent)")
        }
        do {
            let dmg = work.appending(path: Release.dmgName)
            try await Self.download(release.dmg, to: dmg, progress: progress)
            guard try Self.sha256(of: dmg) == release.sha256 else {
                throw UpdateError("The download doesn't match its checksum")
            }
            let staged = try await stage(dmg, version: release.version, in: work)
            try swap(in: staged, keepingOldIn: work)
            return work
        } catch {
            await Self.discard(work)
            throw error
        }
    }

    /// Bridgetown.app from the mounted DMG, copied into `work` and checked.
    func stage(_ dmg: URL, version: AppVersion, in work: URL) async throws -> URL {
        let mount = work.appending(path: "mount")
        let staged = work.appending(path: "Bridgetown.app")
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
        // The checksum covered the whole image already; hdiutil's own pass would take seconds.
        try await Self.run("/usr/bin/hdiutil", ["attach", dmg.path, "-nobrowse", "-readonly", "-noautoopen", "-noverify", "-mountpoint", mount.path], failure: "Couldn't open the download", attempts: 3)
        var copyFailure: Error?
        do {
            try await Self.run("/usr/bin/ditto", [mount.appending(path: "Bridgetown.app").path, staged.path], failure: "Couldn't copy the new app")
        } catch {
            copyFailure = error
        }
        await Self.detach(mount)
        if let copyFailure { throw copyFailure }

        let info = NSDictionary(contentsOf: staged.appending(path: "Contents/Info.plist"))
        guard info?["CFBundleIdentifier"] as? String == bundleIdentifier else {
            throw UpdateError("The download isn't Bridgetown")
        }
        guard let shipped = (info?["CFBundleShortVersionString"] as? String).flatMap(AppVersion.init), shipped == version else {
            throw UpdateError("The download isn't Bridgetown \(version)")
        }
        try await Self.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged.path], failure: "The new app's signature doesn't hold")
        return staged
    }

    /// Two renames on one volume: the running app aside into `work`, the new one in its place.
    func swap(in staged: URL, keepingOldIn work: URL) throws {
        let fm = FileManager.default
        let old = work.appending(path: Self.previous)
        do {
            try fm.moveItem(at: destination, to: old)
        } catch {
            throw UpdateError("Couldn't move \(destination.lastPathComponent) aside")
        }
        do {
            try fm.moveItem(at: staged, to: destination)
        } catch {
            try? fm.moveItem(at: old, to: destination)
            throw UpdateError("Couldn't put the new app in place")
        }
    }

    /// Where `swap` keeps the old app, in `work`.
    static let previous = "Previous.app"

    /// Opens `app` once this process has gone. The new app removes `work` once it is up
    /// (`discard`); if it hasn't within a minute and isn't running, it didn't make it, and the
    /// old app in `work` goes back in its place and opens. The shell outlives us: quitting
    /// doesn't take its children with it.
    static func relaunch(_ app: URL, keptIn work: URL) throws {
        let executable = Bundle(url: app)?.executableURL?.path ?? app.appending(path: "Contents/MacOS/Bridgetown").path
        let script = #"""
        trap '' HUP
        while /bin/kill -0 "$0" 2>/dev/null; do /bin/sleep 0.2; done
        /usr/bin/open "$2"
        i=0
        while [ -d "$1" ] && [ $i -lt 300 ]; do /bin/sleep 0.2; i=$((i + 1)); done
        [ -d "$1" ] || exit 0
        /bin/ps -axo comm= | /usr/bin/grep -qxF "$3" && exit 0
        /bin/mv "$2" "$1/Failed.app" && /bin/mv "$1/\#(previous)" "$2" && /usr/bin/open "$2"
        """#
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script, "\(ProcessInfo.processInfo.processIdentifier)", work.path, app.path, executable]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
    }

    // MARK: Steps

    static func download(_ url: URL, to file: URL, progress: @escaping @Sendable (Int) -> Void) async throws {
        let delegate = DownloadDelegate(file: file, progress: progress)
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            delegate.done = done
            session.downloadTask(with: url).resume()
        }
        progress(100)
    }

    static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Runs `tool`, `attempts` times at most a second apart (hdiutil is sometimes "Resource
    /// busy" for a moment); throws `failure` if it never succeeds. What the tool said goes
    /// to the log.
    static func run(_ tool: String, _ arguments: [String], failure: String, attempts: Int = 1) async throws {
        for attempt in 1...attempts {
            let output: Subprocess.Output
            do {
                output = try await Subprocess.run(tool, arguments)
            } catch {
                log.error("\(tool, privacy: .public) didn't start: \(error.localizedDescription, privacy: .public)")
                throw UpdateError(failure)
            }
            if output.succeeded { return }
            log.error("\(tool, privacy: .public) \(arguments.first ?? "", privacy: .public) exited \(output.status): \(output.errors, privacy: .public)")
            if attempt < attempts { try? await Task.sleep(for: .seconds(1)) }
        }
        throw UpdateError(failure)
    }

    /// Lets go of the image mounted at `mount`, if one is: politely, then by force, a few
    /// times (Spotlight may hold it a moment). By its disk, not its mount point: an image
    /// unmounted but still attached has none, and would stay until a restart.
    static func detach(_ mount: URL) async {
        guard let disk = disk(mountedAt: mount) else { return }
        for force in [false, true, true] {
            let output = try? await Subprocess.run("/usr/bin/hdiutil", ["detach", disk] + (force ? ["-force"] : []))
            if output?.succeeded == true || !FileManager.default.fileExists(atPath: disk) { return }
            try? await Task.sleep(for: .seconds(1))
        }
        log.error("couldn't detach \(disk, privacy: .public): \(mount.path, privacy: .public)")
    }

    /// The disk of the volume mounted at `mount` (/dev/disk12 for /dev/disk12s1), if one is.
    /// Detaching it lets go of the whole image.
    static func disk(mountedAt mount: URL) -> String? {
        var fs = statfs()
        guard isMountPoint(mount), statfs(mount.path, &fs) == 0 else { return nil }
        let device = withUnsafeBytes(of: fs.f_mntfromname) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        return device.firstMatch(of: #/^/dev/disk\d+/#).map { String($0.output) }
    }

    /// Detaches the image in `work`, if still there, and removes `work`.
    static func discard(_ work: URL) async {
        await detach(work.appending(path: "mount"))
        try? FileManager.default.removeItem(at: work)
    }

    /// Whether a volume is mounted at `url`: it is on another device than its folder.
    static func isMountPoint(_ url: URL) -> Bool {
        var own = stat(), parent = stat()
        guard stat(url.path, &own) == 0, stat(url.deletingLastPathComponent().path, &parent) == 0 else { return false }
        return own.st_dev != parent.st_dev
    }
}

/// One download's delegate: progress as it comes, in whole percents, the file moved into
/// place before URLSession deletes it, then the outcome. Called on the session's serial
/// queue only.
private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let file: URL
    let progress: @Sendable (Int) -> Void
    var done: CheckedContinuation<Void, Error>?
    private var failure: Error?
    private var percent = -1

    init(file: URL, progress: @escaping @Sendable (Int) -> Void) {
        self.file = file
        self.progress = progress
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten written: Int64, totalBytesExpectedToWrite expected: Int64) {
        guard expected > 0 else { return }
        // 100 once the file is in place, not when the last byte comes.
        let now = min(99, Int(written * 100 / expected))
        guard now > percent else { return }
        percent = now
        progress(now)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            failure = UpdateError("The download failed (HTTP \(status))")
            return
        }
        do {
            try FileManager.default.moveItem(at: location, to: file)
        } catch {
            failure = UpdateError("Couldn't save the download")
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { done?.resume(throwing: error) }
        else if let failure { done?.resume(throwing: failure) }
        else { done?.resume() }
        done = nil
    }
}
