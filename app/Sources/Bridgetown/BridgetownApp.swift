import AppKit
import SwiftUI

@main
struct BridgetownApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var app

    // No menu bar item: the island in the notch is the app.
    var body: some Scene {
        SwiftUI.Settings {
            SettingsView()
                .environment(app.store)
                .environment(app.daemon)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = Store()
    let daemon = DaemonProcess()
    let notifier = Notifier()
    private(set) lazy var island = IslandController(store: store, daemon: daemon)

    #if DEBUG
    let preview = PreviewHarness(arguments: ProcessInfo.processInfo.arguments)
    #endif

    private var signalSources: [DispatchSourceSignal] = []
    private var newActions = NewActions()

    func applicationDidFinishLaunching(_ notification: Notification) {
        Geist.register()
        NSApp.setActivationPolicy(.accessory)
        installSignalHandlers()

        notifier.start()
        notifier.onOpen = { [weak self] in self?.island.open() }
        // Each new "Needs you" is both a notification and a banner under the notch.
        store.onSnapshot = { [weak self] _, next in
            guard let self else { return }
            let fresh = newActions.update(next)
            guard let first = fresh.first else { return }
            notifier.post(fresh)
            island.announce(first)
        }
        island.start()

        daemon.start()
        if daemon.mode != .missing {
            store.connect(to: daemon.endpoint)
        }

        #if DEBUG
        preview.start(store: store, daemon: daemon, island: island, popoverHeight: preview.popoverHeight ?? Metrics.height)
        #endif
    }

    /// Quit waits for the daemon to shut down (at most ~2.5s) without blocking the main
    /// thread, then lets the app go.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let waiting = daemon.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return waiting ? .terminateLater : .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Route SIGTERM/SIGINT through `terminate` so the daemon child is cleaned up.
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler {
                MainActor.assumeIsolated { NSApp.terminate(nil) }
            }
            source.resume()
            signalSources.append(source)
        }
    }
}
