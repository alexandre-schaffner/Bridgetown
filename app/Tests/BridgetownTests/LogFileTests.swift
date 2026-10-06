import Foundation
import Testing
@testable import Bridgetown

@Suite struct LogFileTests {
    private let dir = FileManager.default.temporaryDirectory.appending(path: "bt-log-test-\(UUID().uuidString)")

    private func contents(_ url: URL) -> String? {
        try? String(contentsOf: url, encoding: .utf8)
    }

    /// Checked on every write, not when the daemon launches: one that runs for weeks would
    /// otherwise never be rotated.
    @Test func pastTheLimitItMovesAsideOnTheNextWrite() {
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = LogFile(url: dir.appending(path: "daemon.log"), limit: 10)
        let previous = log.url.appendingPathExtension("1")
        log.append("first line\n")
        log.append("second\n")
        #expect(contents(log.url) == "second\n")
        #expect(contents(previous) == "first line\n")
        log.append("third\n")
        #expect(contents(log.url) == "second\nthird\n")
        log.append("fourth\n")
        #expect(contents(log.url) == "fourth\n")
        #expect(contents(previous) == "second\nthird\n")
    }

    /// A log left over from an earlier run counts towards the limit.
    @Test func anExistingLogCounts() throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appending(path: "daemon.log")
        try Data("left from before\n".utf8).write(to: url)
        let log = LogFile(url: url, limit: 10)
        log.append("new\n")
        #expect(contents(url) == "new\n")
        #expect(contents(url.appendingPathExtension("1")) == "left from before\n")
    }

    /// Deleted to clear it while the daemon runs: Open logs finds a file, and the daemon's
    /// next lines go into it, not into the one that is gone.
    @Test func aDeletedLogIsThereAgainToOpen() throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = LogFile(url: dir.appending(path: "daemon.log"))
        log.append("before\n")
        try FileManager.default.removeItem(at: log.url)
        log.create()
        #expect(contents(log.url) == "")
        log.append("after\n")
        #expect(contents(log.url) == "after\n")
    }

    @Test func createMakesAnEmptyLogToOpen() {
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = LogFile(url: dir.appending(path: "nested/daemon.log"))
        log.create()
        #expect(contents(log.url) == "")
    }
}
