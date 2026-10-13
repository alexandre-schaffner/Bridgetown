import AppKit

/// Quits the app. Quit waits for the daemon to shut down: `applicationShouldTerminate`
/// answers `.terminateLater`, and AppKit runs its own event loop until the daemon's
/// process reports back on the main actor. Started inside a main-actor task or a block
/// on the main queue, that loop can't run the report, and the app hangs. So quit always
/// starts from the run loop: in its default mode, or under a modal panel (an open
/// `NSOpenPanel`, or that very wait), which would otherwise hold it until the panel closes.
///
/// Don't answer `.terminateCancel` and quit again later instead: a quit from logout,
/// restart or shutdown would read that as Bridgetown cancelling it.
///
/// Its own target, so `TerminationHarness` runs this very code in a real app.
public enum AppTermination {
    public static func quit() {
        RunLoop.main.perform(inModes: [.default, .modalPanel]) {
            MainActor.assumeIsolated { NSApp.terminate(nil) }
        }
    }
}
