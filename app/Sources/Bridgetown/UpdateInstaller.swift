import CryptoKit
import Foundation

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
/// `relaunch` then waits for this process to quit, removes what is left and opens the new app.
/// The download is never quarantined (URLSession doesn't set the flag), so the new app
/// opens without Gatekeeper's "Open Anyway".
struct UpdateInstaller: Sendable {
    /// The app bundle to replace.
    let destination: URL
    /// What the new bundle must call itself.
    let bundleIdentifier: String

    /// Whether `bundle` can be swapped for another: not translocated (run from where it was
    /// downloaded, on a read-only mirror), and its folder writable.
    static func canReplace(_ bundle: URL) -> Bool {
        let fm = FileManager.default
        return !bundle.path.contains("/AppTranslocation/")
            && fm.isWritableFile(atPath: bundle.deletingLastPathComponent().path)
            && fm.isWritableFile(atPath: bundle.path)
    }

    /// Installs `release` over `destination`. `progress` hears the download's fraction.
    /// Returns the folder holding the old app, for `relaunch` to remove once this one quits.
    func install(_ release: Release, progress: @escaping @Sendable (Double) -> Void) async throws -> URL {
        let fm = FileManager.default
        let work: URL
        do {
            work = try fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: destination, create: true)
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
            try? fm.removeItem(at: work)
            throw error
        }
    }

    /// Bridgetown.app from the mounted DMG, copied into `work` and checked.
    func stage(_ dmg: URL, version: AppVersion, in work: URL) async throws -> URL {
        let mount = work.appending(path: "mount")
        let staged = work.appending(path: "Bridgetown.app")
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
        // The checksum covered the whole image already; hdiutil's own pass would take seconds.
        try await Self.run("/usr/bin/hdiutil", ["attach", dmg.path, "-nobrowse", "-readonly", "-noautoopen", "-noverify", "-mountpoint", mount.path], failure: "Couldn't open the download")
        do {
            try await Self.run("/usr/bin/ditto", [mount.appending(path: "Bridgetown.app").path, staged.path], failure: "Couldn't copy the new app")
        } catch {
            try? await Self.run("/usr/bin/hdiutil", ["detach", mount.path, "-force"], failure: "")
            throw error
        }
        try? await Self.run("/usr/bin/hdiutil", ["detach", mount.path, "-force"], failure: "")

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
        let old = work.appending(path: "Previous.app")
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

    /// Opens `app` once this process has gone, and removes `leftover`. The shell outlives
    /// us: quitting doesn't take its children with it.
    static func relaunch(_ app: URL, removing leftover: URL) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = [
            "-c",
            #"trap '' HUP; while /bin/kill -0 "$0" 2>/dev/null; do /bin/sleep 0.2; done; /bin/rm -rf "$1"; /usr/bin/open "$2""#,
            "\(ProcessInfo.processInfo.processIdentifier)", leftover.path, app.path,
        ]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
    }

    // MARK: Steps

    static func download(_ url: URL, to file: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
        let delegate = DownloadDelegate(file: file, progress: progress)
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            delegate.done = done
            session.downloadTask(with: url).resume()
        }
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

    /// Runs a tool to the end without holding a thread; throws `failure` if it fails.
    static func run(_ tool: String, _ arguments: [String], failure: String) async throws {
        let status: Int32 = try await withCheckedThrowingContinuation { done in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: tool)
            p.arguments = arguments
            p.standardInput = FileHandle.nullDevice
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            p.terminationHandler = { done.resume(returning: $0.terminationStatus) }
            do {
                try p.run()
            } catch {
                done.resume(throwing: error)
            }
        }
        guard status == 0 else { throw UpdateError(failure) }
    }
}

/// One download's delegate: progress as it comes, the file moved into place before
/// URLSession deletes it, then the outcome. Called on the session's serial queue only.
private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let file: URL
    let progress: @Sendable (Double) -> Void
    var done: CheckedContinuation<Void, Error>?
    private var failure: Error?

    init(file: URL, progress: @escaping @Sendable (Double) -> Void) {
        self.file = file
        self.progress = progress
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten written: Int64, totalBytesExpectedToWrite expected: Int64) {
        guard expected > 0 else { return }
        progress(Double(written) / Double(expected))
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
