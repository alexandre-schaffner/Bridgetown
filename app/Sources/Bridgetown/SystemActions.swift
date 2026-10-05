import AppKit
import SwiftUI

/// Side effects outside the app: URLs, the log file, Terminal takeover, the Settings window.
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
        case openURL, openLogs, takeOver, openSettings
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

    /// `cd '<worktree>' && claude --resume <id>` in a new Terminal window.
    /// Returns an error message on failure.
    static func takeOver(_ session: Session) -> String? {
        guard let id = session.claudeSessionId else { return "No Claude session to resume yet" }
        let dir = session.worktree ?? FileManager.default.homeDirectoryForCurrentUser.path
        let shell = "cd \(shellQuote(dir)) && claude --resume \(shellQuote(id))"
        #if DEBUG
        if let sink {
            sink(.takeOver, shell)
            return nil
        }
        #endif
        let script = """
        tell application "Terminal"
            do script "\(appleScriptEscape(shell))"
            activate
        end tell
        """
        var error: NSDictionary?
        NSAppleScript(source: script)?.executeAndReturnError(&error)
        if let error {
            return (error[NSAppleScript.errorMessage] as? String) ?? "Couldn't open Terminal"
        }
        return nil
    }

    private static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func appleScriptEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }
}
