import AppKit
import SwiftUI

@main
struct BridgetownApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var app

    // No menu bar item: the island in the notch is the app.
    var body: some Scene {
        SwiftUI.Settings {
            SettingsView().services(app.services)
        }
    }
}

/// What every window's views find in their environment: the store, the daemon and the
/// updater, and links opened the app's way (`SystemActions.openLink`).
@MainActor
struct AppServices {
    let store: Store
    let daemon: DaemonProcess
    let updater: Updater
}

extension View {
    /// Set at each window's root: the island's panel, Settings, an e2e run's surfaces.
    func services(_ services: AppServices) -> some View {
        environment(services.store)
            .environment(services.daemon)
            .environment(services.updater)
            .environment(\.openURL, SystemActions.openLink)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = Store()
    let daemon = DaemonProcess()
    let notifier = Notifier()
    /// An e2e run puts its own in, before the island exists.
    var updater = Updater()
    var services: AppServices { AppServices(store: store, daemon: daemon, updater: updater) }
    private(set) lazy var island = IslandController(services: services)

    #if DEBUG
    /// `--e2e …` or `--island-demo` (E2E/E2EHarness.swift); nil on a normal launch.
    let harness = E2EHarness(arguments: ProcessInfo.processInfo.arguments)
    #endif

    private var signalSources: [DispatchSourceSignal] = []
    private var newActions = NewActions()

    func applicationDidFinishLaunching(_ notification: Notification) {
        Geist.register()
        NSApp.setActivationPolicy(.accessory)
        installSignalHandlers()

        #if DEBUG
        // Before anything starts: a run swaps out the clock, the Keychain, side effects,
        // the daemon's environment and the island's panel, and posts no notifications.
        harness?.configure(self)
        #endif
        if isLive { notifier.start() }
        notifier.onOpen = { [weak self] in self?.island.open() }
        // Each new "Needs you" is both a notification and a banner under the notch.
        store.onSnapshot = { [weak self] next in
            guard let self else { return }
            let fresh = newActions.update(next)
            // A notification goes once its action does, here or while the app was closed.
            notifier.withdraw(allBut: Set(next.actions.map(\.id)))
            guard let first = fresh.first else { return }
            notifier.post(fresh)
            island.announce(first)
        }
        island.start()

        // A newer release is a notification, once, and a line in the open island.
        updater.onAvailable = { [weak self] release in self?.notifier.post(update: release) }
        if isLive { updater.start() }

        #if DEBUG
        // It starts the daemon itself, once it has shown the app connecting.
        if let harness { return harness.start(self) }
        #endif
        startDaemon()
    }

    /// A normal launch: not an e2e run, which posts no notifications and checks for no updates.
    private var isLive: Bool {
        #if DEBUG
        harness == nil
        #else
        true
        #endif
    }

    func startDaemon() {
        switch daemon.mode {
        case .missing:
            return
        case .attach:
            store.connect(to: daemon.endpoint)
        case .command, .bundled:
            // Each launch is a new daemon: the stream starts over on it at once, and until it
            // answers it is starting, not lost.
            daemon.onLaunch = { [weak self] in
                guard let self else { return }
                store.connect(to: daemon.endpoint)
            }
            daemon.start()
        }
    }

    /// Quit waits for the daemon to shut down (at most ~2.5s) without blocking the main
    /// thread, then lets the app go.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let waiting = daemon.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return waiting ? .terminateLater : .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Opening Bridgetown again (Finder, Spotlight, `open -a`) unfolds the island: with no
    /// Dock icon or menu bar item, that is the way in when you can't see where it hangs.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        island.open()
        return false
    }

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
