import AppKit

/// Quits the app. Quit waits for the daemon to shut down: `applicationShouldTerminate`
/// answers `.terminateLater`, and AppKit runs its own event loop until the daemon's
/// process reports back on the main actor. Started inside a main-actor task or a block
/// on the main queue, that loop can't run the report, and the app hangs. So quit always
/// starts from the run loop.
///
/// Don't answer `.terminateCancel` and quit again later instead: a quit from logout,
/// restart or shutdown would read that as Bridgetown cancelling it.
enum AppTermination {
    static func quit() {
        RunLoop.main.perform { MainActor.assumeIsolated { NSApp.terminate(nil) } }
    }
}
