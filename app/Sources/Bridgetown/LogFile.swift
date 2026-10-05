import Foundation

/// `daemon.log`: the daemon's output and the app's notes about it. Once it passes `limit`
/// it becomes `daemon.log.1`, replacing the one before, checked on every write, so a daemon
/// that runs for weeks and logs a failure every poll stays within twice that.
///
/// The app writes from the main actor and the daemon's output arrives on the pipe's own
/// queue, so one lock keeps the handle and its size.
final class LogFile: @unchecked Sendable {
    let url: URL
    private let limit: Int
    private let lock = NSLock()
    private var handle: FileHandle?
    private var size = 0

    init(url: URL, limit: Int = 10_000_000) {
        self.url = url
        self.limit = limit
    }

    func append(_ text: String) {
        append(Data(text.utf8))
    }

    func append(_ data: Data) {
        lock.withLock {
            if handle == nil { open() }
            if size > limit { rotate() }
            try? handle?.write(contentsOf: data)
            size += data.count
        }
    }

    /// Creates the file and its directory if they aren't there, to open it in Console.
    func create() {
        lock.withLock {
            if handle == nil { open() }
        }
    }

    private func open() {
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: nil)
        }
        handle = try? FileHandle(forWritingTo: url)
        size = Int((try? handle?.seekToEnd()) ?? 0)
    }

    private func rotate() {
        try? handle?.close()
        let previous = url.appendingPathExtension("1")
        try? FileManager.default.removeItem(at: previous)
        try? FileManager.default.moveItem(at: url, to: previous)
        open()
    }
}
