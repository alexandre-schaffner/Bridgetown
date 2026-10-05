import AppKit
import Observation
import SwiftUI

/// Bridgetown in the notch: there is no menu bar item, so the island is always there to
/// click, and opening the app again opens it too (`AppDelegate`).
///
/// A transparent panel above the menu bar holds the island (`IslandView`). It lets the
/// pointer through everywhere but the island itself, so it never blocks the menu bar or
/// the windows under it.
///
/// - Hovering swells the island (and taps the trackpad); pressing it opens it.
/// - A new "Needs you" drops a banner under the notch for a few seconds.
/// - Open, it takes keyboard focus without activating the app, like Spotlight; Esc, a
///   click outside, or opening another of the app's windows closes it.
@MainActor
final class IslandController {
    let model: IslandModel
    private let store: Store
    private let daemon: DaemonProcess
    private var panel: IslandPanel?
    private var monitors: [Any] = []
    private var observers: [NSObjectProtocol] = []
    private var bannerTask: Task<Void, Never>?
    private var resignTask: Task<Void, Never>?
    private var hoverTask: Task<Void, Never>?

    /// Pointer onto the island, then a click: the hover tap and the open tap within this
    /// are one gesture (measured 260–370ms apart), so the open one is dropped.
    private static let hoverToClick: TimeInterval = 0.8

    #if DEBUG
    /// Set before `start()` by an e2e run, which renders the island itself (`E2ESurfaces`):
    /// no panel at the notch, so no event monitors, no observers, never key. The model is
    /// still driven as usual: open, close, banners and the glance.
    var offscreen = false
    #endif

    // Springs: opening overshoots a touch, as if the notch were elastic; closing doesn't.
    // Under Reduce Motion everything is a short ease with no bounce.
    static var opening: Animation { motion(.spring(response: 0.5, dampingFraction: 0.74)) }
    static var closing: Animation { motion(.spring(response: 0.38, dampingFraction: 0.92)) }
    static var swell: Animation { motion(.spring(response: 0.32, dampingFraction: 0.62)) }
    static var settle: Animation { motion(.spring(response: 0.45, dampingFraction: 0.8)) }

    private static func motion(_ animation: Animation) -> Animation {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? .easeInOut(duration: 0.2) : animation
    }

    init(store: Store, daemon: DaemonProcess) {
        self.store = store
        self.daemon = daemon
        model = IslandModel(geometry: .current())
    }

    func start() {
        guard panel == nil else { return }
        #if DEBUG
        if offscreen { return observeGlance() }
        #endif
        let panel = IslandPanel()
        panel.onCancel = { [weak self] in self?.close() }
        let root = IslandView(model: model) { [weak self] in self?.open() }
            .environment(store)
            .environment(daemon)
            .environment(\.openURL, SystemActions.openLink)
        let host = FirstMouseHostingView(rootView: root)
        host.sizingOptions = []
        panel.contentView = host
        self.panel = panel
        place()
        panel.orderFrontRegardless()

        installMonitors()
        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.place() }
        })
        // Settings, or any other window of ours, takes over from the island.
        observers.append(NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main
        ) { [weak self] note in
            let window = note.object as? NSWindow
            MainActor.assumeIsolated {
                guard let self, let window, window !== self.panel else { return }
                self.close()
            }
        })
        observeGlance()
    }

    // MARK: Presentation

    func open() {
        guard model.presentation != .open else { return }
        bannerTask?.cancel()
        resignTask?.cancel()
        if model.presentation == .banner { store.back() }
        withAnimation(Self.opening) {
            model.presentation = .open
            model.hovering = false
        }
        // The hover tap plays 90ms after the pointer arrives; a click that follows it is
        // the same reach for the island, so it doesn't tap again.
        Haptics.perform(.levelChange, "island.open", gap: Self.hoverToClick)
        panel?.keyable = true
        panel?.makeKey()
        trackPointer()
    }

    func close() {
        guard model.presentation != .resting else { return }
        bannerTask?.cancel()
        withAnimation(Self.closing) {
            model.presentation = .resting
            // Without a panel nothing is under the pointer, wherever it is on the screen.
            model.hovering = panel != nil && model.frame.contains(NSEvent.mouseLocation)
        }
        trackPointer()
        resignKey()
    }

    func toggle() {
        model.presentation == .open ? close() : open()
    }

    /// A new "Needs you" drops a banner, unless the island is open already.
    func announce(_ action: Action) {
        guard model.presentation != .open else { return }
        showBanner(action)
    }

    func showBanner(_ action: Action) {
        withAnimation(Self.opening) {
            model.banner = action
            model.presentation = .banner
        }
        trackPointer()
        bannerTask?.cancel()
        bannerTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5.5))
            // Held open while the pointer is on it.
            while let self, self.model.hovering, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(400))
            }
            guard !Task.isCancelled, let self, self.model.presentation == .banner else { return }
            self.close()
        }
    }

    private func observeGlance() {
        let next = withObservationTracking {
            Glance(store: store, daemon: daemon)
        } onChange: { [weak self] in
            Task { @MainActor in self?.observeGlance() }
        }
        guard next != model.glance else { return }
        withAnimation(Self.settle) { model.glance = next }
        trackPointer()
    }

    // MARK: Panel

    /// The panel, hung from the top edge, centred on the notch.
    private func place() {
        model.geometry = .current()
        guard let panel else { return }
        let g = model.geometry
        let size = Self.panelSize(g, glance: model.glance)
        panel.setFrame(NSRect(x: g.centerX - size.width / 2, y: g.top - size.height, width: size.width, height: size.height), display: true)
    }

    /// The open island plus room for its whole shadow: it falls 14pt and blurs 26pt, so it
    /// needs about 80 below and 60 aside; less cuts it off in a hard line.
    static func panelSize(_ geometry: NotchGeometry, glance: Glance) -> CGSize {
        let side: CGFloat = 64
        let below: CGFloat = 88
        let width = IslandModel.layout(.open, hovering: false, glance: glance, geometry: geometry).frameWidth + 2 * side
        return CGSize(width: width, height: geometry.notch.height + geometry.openHeight + below)
    }

    /// A key, non-activating panel keeps keyboard focus after it closes; ordering it out
    /// and back hands focus back to the app you were in. Done once the close has played,
    /// so it can't be seen.
    private func resignKey() {
        guard let panel, panel.isKeyWindow else { return }
        panel.keyable = false
        resignTask?.cancel()
        resignTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(450))
            guard !Task.isCancelled, let self, let panel = self.panel, self.model.presentation != .open else { return }
            panel.orderOut(nil)
            panel.orderFrontRegardless()
        }
    }

    // MARK: Pointer

    private func installMonitors() {
        let moves: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged]
        let clicks: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown]
        if let m = NSEvent.addGlobalMonitorForEvents(matching: moves, handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.trackPointer(moved: true) }
        }) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: moves, handler: { [weak self] event in
            MainActor.assumeIsolated { self?.trackPointer(moved: true) }
            return event
        }) { monitors.append(m) }
        // A press on the island opens it; anywhere else, in another app (global) or another
        // of our windows (local), closes it.
        if let m = NSEvent.addGlobalMonitorForEvents(matching: clicks, handler: { [weak self] event in
            MainActor.assumeIsolated { self?.pressed(event) }
        }) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: clicks, handler: { [weak self] event in
            MainActor.assumeIsolated { self?.pressed(event) }
            return event
        }) { monitors.append(m) }
    }

    /// Opens on the press, not the release, the way a menu does. The first press can reach
    /// the island before any pointer move has let the panel take the mouse (it then lands
    /// on the menu bar under it, seen by the global monitor) or while the panel is not key
    /// yet; opening from here makes the first click count either way.
    private func pressed(_ event: NSEvent) {
        let point = NSEvent.mouseLocation
        if model.presentation != .open, event.type == .leftMouseDown, hitFrame.contains(point) {
            open()
            return
        }
        guard model.presentation != .resting, !model.frame.contains(point) else { return }
        close()
    }

    /// The island's frame plus the screen's top row, which the pointer can sit on a hair
    /// above the frame's open edge.
    private var hitFrame: NSRect {
        model.frame.insetBy(dx: -2, dy: 0).offsetBy(dx: 0, dy: 1).union(model.frame)
    }

    /// The panel takes the pointer only over the island; hovering the resting island swells it.
    ///
    /// `moved` is true only from the pointer monitors. Otherwise the island changed under a
    /// still pointer (it grew, a banner dropped, it closed), and that is not you arriving:
    /// it may swell, but silently. Arriving taps the trackpad once the pointer has rested
    /// a moment and no button is held, so sweeping across the menu bar or dragging a
    /// window past the notch stays quiet.
    private func trackPointer(moved: Bool = false) {
        guard let panel, panel.isVisible else { return }
        let point = NSEvent.mouseLocation
        // The pointer can sit on the screen's top row, a hair above the frame's open edge.
        let inside = hitFrame.contains(point)
        panel.ignoresMouseEvents = !inside
        guard model.presentation != .open else { return }
        guard inside else {
            hoverTask?.cancel()
            hoverTask = nil
            if model.hovering { withAnimation(Self.swell) { model.hovering = false } }
            return
        }
        guard !model.hovering else { return }
        guard moved, NSEvent.pressedMouseButtons == 0 else {
            if !moved { withAnimation(Self.swell) { model.hovering = true } }
            return
        }
        guard hoverTask == nil else { return }
        hoverTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(90))
            guard !Task.isCancelled, let self else { return }
            self.hoverTask = nil
            guard self.model.presentation != .open, !self.model.hovering,
                  NSEvent.pressedMouseButtons == 0,
                  self.hitFrame.contains(NSEvent.mouseLocation)
            else { return }
            Haptics.perform(.alignment, "island.hover")
            withAnimation(Self.swell) { self.model.hovering = true }
        }
    }
}

#if DEBUG
extension IslandController {
    /// Hovering without a pointer: `--island-demo`, and the e2e run's hover shots.
    func previewHover(_ hovering: Bool) {
        if hovering { Haptics.perform(.alignment, "island.previewHover") }
        withAnimation(Self.swell) { model.hovering = hovering }
    }
}
#endif

/// Takes the click that brings the panel forward as a click: the island is never key while
/// resting, and without this its first click only focuses it.
private final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Borderless, transparent, above the menu bar, on every Space and over full-screen apps.
final class IslandPanel: NSPanel {
    /// Only while open, so the resting island never steals focus.
    var keyable = false
    var onCancel: (() -> Void)?

    init() {
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isFloatingPanel = true
        level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        isMovable = false
        hidesOnDeactivate = false
        acceptsMouseMovedEvents = true
        ignoresMouseEvents = true
        animationBehavior = .none
    }

    override var canBecomeKey: Bool { keyable }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }
}
