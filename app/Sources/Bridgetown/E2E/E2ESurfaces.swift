#if DEBUG
import AppKit
import SwiftUI

/// What a run photographs: the app's real roots, each in a borderless window parked far
/// off screen that is never ordered in or made key, so nothing shows on the user's
/// screen and nothing takes focus. Views lay out, animate and draw there as on screen.
///
/// - `open`: the open island (`IslandOpenView` on the controller's own model), at a preset size.
/// - `notch`: the whole island (`IslandView`) at a fixed notch, over a painted menu bar.
/// - `settings`: the Settings window's content.
@MainActor
final class E2ESurfaces {
    struct Shown {
        let spec: E2EStep.Surface
        let window: NSWindow
        let host: NSView
        var name: String
        /// Drawn on the island's black stage: Geist only, and dark whatever the appearance.
        var stage: Bool
    }

    /// The notch every `open` shot hangs from, and the two `notch` presets: the 14" MacBook
    /// Pro's notch (as IslandLayoutTests), and a screen without one.
    static func geometry(_ preset: String, open: CGSize = CGSize(width: NotchGeometry.maxOpenWidth, height: NotchGeometry.maxOpenHeight)) -> NotchGeometry {
        preset == "flat"
            ? NotchGeometry(top: 900, centerX: 720, notch: CGSize(width: NotchGeometry.standInWidth, height: 24), openWidth: open.width, openHeight: open.height)
            : NotchGeometry(top: 982, centerX: 756, notch: CGSize(width: 185, height: 32), openWidth: open.width, openHeight: open.height)
    }

    private let store: Store
    private let daemon: DaemonProcess
    private let island: IslandController
    let defaults: UserDefaults
    private(set) var current: Shown?

    init(store: Store, daemon: DaemonProcess, island: IslandController, defaults: UserDefaults) {
        self.store = store
        self.daemon = daemon
        self.island = island
        self.defaults = defaults
    }

    /// Builds the surface afresh, so view state (an expanded card, a scroll) starts over.
    @discardableResult
    func show(_ spec: E2EStep.Surface) -> Shown {
        current?.window.close()
        let root: AnyView
        let size: CGSize
        let name: String
        switch spec {
        case let .open(width, height, preset):
            island.model.geometry = Self.geometry("hardware", open: CGSize(width: width, height: height))
            root = AnyView(IslandOpenView(model: island.model))
            size = CGSize(width: width, height: island.model.geometry.notch.height + height)
            name = "open/\(preset)"
        case let .notch(preset):
            island.model.geometry = Self.geometry(preset)
            let island = island
            root = AnyView(IslandView(model: island.model) { island.open() })
            size = IslandController.panelSize(island.model.geometry, glance: island.model.glance)
            name = "notch/\(preset)"
        case let .settings(tab):
            root = AnyView(SettingsView(initialTab: tab))
            size = CGSize(width: 480, height: 400)
            name = "settings/\(tab.rawValue)"
        }
        let host = NSHostingView(rootView: AnyView(root.modifier(E2EEnvironment(store: store, daemon: daemon, defaults: defaults))))
        // Settings is as tall as its tab's content, as its own window is; the island's are fixed.
        host.sizingOptions = spec.isStage ? [] : [.intrinsicContentSize]
        let window = NSWindow(
            contentRect: NSRect(origin: CGPoint(x: -20_000, y: -20_000), size: size),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.backgroundColor = .clear
        window.isOpaque = false
        window.contentView = host
        let shown = Shown(spec: spec, window: window, host: host, name: name, stage: spec.isStage)
        current = shown
        fit()
        return shown
    }

    /// Settings grows to its content as it loads; the island's surfaces keep their size.
    func fit() {
        guard let current, case .settings = current.spec else { return }
        current.host.layoutSubtreeIfNeeded()
        let height = max(120, current.host.intrinsicContentSize.height)
        guard abs(current.window.frame.height - height) > 0.5 else { return }
        current.window.setFrame(NSRect(x: -20_000, y: -20_000, width: 480, height: height), display: false)
    }

    /// What the surface sits on: the stage's black, the window background Settings has in
    /// its appearance, or a desktop with a menu bar (and a notch) for the island.
    func paintBackdrop(_ bounds: CGRect) {
        guard let current else { return }
        switch current.spec {
        case .open:
            NSColor.black.setFill()
            bounds.fill()
        case .settings:
            NSColor.windowBackgroundColor.setFill()
            bounds.fill()
        case let .notch(preset):
            let notch = island.model.geometry.notch
            NSColor(white: 0.42, alpha: 1).setFill()
            bounds.fill()
            let menuBar = CGRect(x: bounds.minX, y: bounds.maxY - notch.height, width: bounds.width, height: notch.height)
            // A shade off black, so the island reads against it as the notch does on a real screen.
            (preset == "flat" ? NSColor(white: 0.93, alpha: 1) : NSColor(white: 0.11, alpha: 1)).setFill()
            menuBar.fill()
            if preset == "hardware" {
                NSColor.black.setFill()
                NSBezierPath(roundedRect: CGRect(x: bounds.midX - notch.width / 2, y: bounds.maxY - notch.height, width: notch.width, height: notch.height), xRadius: 8, yRadius: 8).fill()
            }
        }
    }
}

private extension E2EStep.Surface {
    var isStage: Bool {
        if case .settings = self { false } else { true }
    }
}

/// The same for every surface: the app's environment, controls drawn as in a key window
/// (the island always is), 2x, and en_US in UTC. Nothing moves: every change lands at
/// once (a spring's last sub-pixel steps would settle a shot a hair early, differently
/// each run), and Reduce Motion stills what loops on the clock (pulses, shimmer).
private struct E2EEnvironment: ViewModifier {
    let store: Store
    let daemon: DaemonProcess
    let defaults: UserDefaults

    func body(content: Content) -> some View {
        content
            .environment(store)
            .environment(daemon)
            .environment(\.openURL, SystemActions.openLink)
            .environment(\.controlActiveState, .key)
            .environment(\._accessibilityReduceMotion, true)
            .environment(\.displayScale, E2ECapture.scale)
            .environment(\.locale, Locale(identifier: "en_US"))
            .environment(\.timeZone, TimeZone(identifier: "UTC") ?? .current)
            .defaultAppStorage(defaults)
            .transaction {
                $0.animation = nil
                $0.disablesAnimations = true
            }
    }
}
#endif
