import AppKit
import SwiftUI

/// Side effects outside the app: URLs, the log file, Terminal takeover, the Settings window,
/// the clipboard.
@MainActor
enum SystemActions {
    /// URLs from the daemon originate partly with agents, so only web, Slack and Revv
    /// links open; anything else (`file:`, `x-apple…`, custom app schemes) is ignored.
    nonisolated static let openableSchemes: Set<String> = ["https", "slack", "revv"]

    nonisolated static func openableURL(_ urlString: String?) -> URL? {
        guard let urlString, let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(), openableSchemes.contains(scheme)
        else { return nil }
        return url
    }

    #if DEBUG
    enum Effect: String, Codable {
        case openURL, openLogs, takeOver, openSettings, copy
    }

    /// While set, every side effect is handed here instead of happening: an e2e run
    /// records what a click would have opened, and never opens a browser, Terminal or a
    /// window of its own, or takes focus.
    static var sink: ((Effect, String) -> Void)?
    #endif

    static func open(_ urlString: String?) {
        guard let url = openableURL(urlString) else { return }
        #if DEBUG
        if let sink { return sink(.openURL, url.absoluteString) }
        #endif
        NSWorkspace.shared.open(url)
    }

    /// Links in text (Markdown from alerts and agents) go through `open` too: SwiftUI's own
    /// action opens any scheme. Each root sets it as `\.openURL`.
    static let openLink = OpenURLAction { url in
        MainActor.assumeIsolated { open(url.absoluteString) }
        return .handled
    }

    /// The daemon's log in Console, created if it isn't there yet.
    static func openLogs(_ log: LogFile) {
        #if DEBUG
        if let sink { return sink(.openLogs, log.url.path) }
        #endif
        log.create()
        NSWorkspace.shared.open(log.url)
    }

    /// The app forward, then its Settings window (SwiftUI's `openSettings`).
    static func showSettings(_ openSettings: OpenSettingsAction) {
        #if DEBUG
        if let sink { return sink(.openSettings, "") }
        #endif
        NSApp.activate()
        openSettings()
    }

    static func copy(_ text: String) {
        #if DEBUG
        if let sink { return sink(.copy, text) }
        #endif
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    /// `takeOverCommand` in a new Terminal window. Returns an error message on failure.
    static func takeOver(_ session: Session) async -> String? {
        guard let id = session.claudeSessionId else { return "No Claude session to resume yet" }
        let shell = takeOverCommand(worktree: session.worktree, claudeSessionId: id,
                                    home: FileManager.default.homeDirectoryForCurrentUser.path)
        #if DEBUG
        if let sink {
            sink(.takeOver, shell)
            return nil
        }
        #endif
        return await runAppleScript("""
        tell application "Terminal"
            do script "\(appleScriptEscape(shell))"
            activate
        end tell
        """)
    }

    /// `cd '<worktree>' && claude --resume <id>`, after `git worktree lock` on the worktree: taken
    /// over, it is yours, and the daemon's housekeeping never deletes a locked worktree (nor its
    /// branch), whatever you changed there. `git worktree unlock` hands it back. Plain `;` and
    /// `&&`, so it reads the same in bash, zsh and fish.
    nonisolated static func takeOverCommand(worktree: String?, claudeSessionId id: String, home: String) -> String {
        let resume = "claude --resume \(shellQuote(id))"
        guard let worktree else { return "cd \(shellQuote(home)) && \(resume)" }
        let dir = shellQuote(worktree)
        return "git -C \(dir) worktree lock --reason 'Taken over from Bridgetown' . 2>/dev/null; cd \(dir) && \(resume)"
    }

    /// Runs `source` in osascript and returns its error, if any. Not NSAppleScript, which
    /// holds the main thread until the script ends: the first takeover waits on the
    /// Automation prompt, and any on Terminal launching, and the island would freeze.
    nonisolated static func runAppleScript(_ source: String) async -> String? {
        await withCheckedContinuation { done in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            p.arguments = ["-e", source]
            let errors = Pipe()
            p.standardError = errors
            p.standardOutput = FileHandle.nullDevice
            p.terminationHandler = { p in
                let stderr = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                done.resume(returning: p.terminationStatus == 0 ? nil : scriptError(stderr))
            }
            do {
                try p.run()
            } catch {
                done.resume(returning: error.userMessage)
            }
        }
    }

    /// "Not authorized to send Apple events to Terminal." from osascript's
    /// "0:83: execution error: Not authorized to send Apple events to Terminal. (-1743)".
    nonisolated static func scriptError(_ stderr: String) -> String {
        var message = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = message.range(of: "execution error: ") { message = String(message[range.upperBound...]) }
        if let code = message.range(of: #" \(-?\d+\)$"#, options: .regularExpression) { message.removeSubrange(code) }
        return message.isEmpty ? "Couldn't open Terminal" : message
    }

    private nonisolated static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func appleScriptEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }
}
