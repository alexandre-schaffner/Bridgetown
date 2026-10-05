import AppKit
import Observation

/// Where the island hangs: the notch of the built-in display, or on a screen without one,
/// a notch-sized place at the top centre of the main screen.
struct NotchGeometry: Equatable {
    /// The screen's top edge and the notch's centre, in global screen coordinates.
    var top: CGFloat
    var centerX: CGFloat
    var notch: CGSize
    /// The open island: wide and shallow, under the notch.
    var openWidth: CGFloat
    /// Its height below the notch.
    var openHeight: CGFloat

    /// The notch's width on a screen without one.
    static let standInWidth: CGFloat = 190
    /// The open island at most, less a margin on smaller screens.
    static let maxOpenWidth: CGFloat = 1100
    static let maxOpenHeight: CGFloat = 480

    @MainActor
    static func current() -> NotchGeometry {
        let screens = NSScreen.screens
        let screen = screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main ?? screens.first
        guard let screen else {
            return NotchGeometry(
                top: 900, centerX: 720, notch: CGSize(width: standInWidth, height: 32),
                openWidth: maxOpenWidth, openHeight: maxOpenHeight
            )
        }
        let frame = screen.frame
        let inset = screen.safeAreaInsets.top
        let notch: CGSize
        let centerX: CGFloat
        if inset > 0, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            notch = CGSize(width: frame.width - left.width - right.width, height: inset)
            centerX = frame.minX + left.width + notch.width / 2
        } else {
            let menuBar = frame.maxY - screen.visibleFrame.maxY
            notch = CGSize(width: Self.standInWidth, height: menuBar > 0 ? menuBar : 24)
            centerX = frame.midX
        }
        return NotchGeometry(
            top: frame.maxY,
            centerX: centerX,
            notch: notch,
            openWidth: min(Self.maxOpenWidth, frame.width - 160),
            openHeight: min(Self.maxOpenHeight, frame.height - notch.height - 160)
        )
    }
}

/// What the closed island shows beside the notch.
struct Glance: Equatable {
    /// Running agents (left wing).
    var working = 0
    /// "Needs you" actions (right wing, first).
    var waiting = 0
    /// Lost the daemon, or it can't start.
    var trouble = false

    var isEmpty: Bool { working == 0 && waiting == 0 && !trouble }

    init(working: Int = 0, waiting: Int = 0, trouble: Bool = false) {
        self.working = working
        self.waiting = waiting
        self.trouble = trouble
    }

    @MainActor
    init(store: Store, daemon: DaemonProcess) {
        let connected = store.connection == .connected
        working = connected ? store.activeSessions.count : 0
        waiting = connected ? store.actions.count : 0
        trouble = daemon.mode == .missing || daemon.state == .portInUse || store.connection == .rejected
            || (store.snapshot != nil && !connected)
    }
}

/// The island's frame and shape for one state.
struct IslandLayout: Equatable {
    /// The body, between the shoulders.
    var width: CGFloat
    var height: CGFloat
    var shoulder: CGFloat
    var corner: CGFloat
    /// Floating over the desktop, with a shadow and a lit edge, rather than flush with the notch.
    var lifted = false

    var frameWidth: CGFloat { width + 2 * shoulder }
}

@MainActor
@Observable
final class IslandModel {
    enum Presentation: Equatable {
        /// Tucked behind the notch, or wings either side of it when there is something to glance at.
        case resting
        /// A new "Needs you", for a few seconds.
        case banner
        /// The whole app.
        case open
    }

    var presentation: Presentation = .resting
    var hovering = false
    var glance = Glance()
    var banner: Action?
    var geometry: NotchGeometry

    /// Each wing's width beside the notch.
    static let wing: CGFloat = 38
    static let bannerWidth: CGFloat = 360
    static let bannerHeight: CGFloat = 64

    init(geometry: NotchGeometry) {
        self.geometry = geometry
    }

    var layout: IslandLayout { Self.layout(presentation, hovering: hovering, glance: glance, geometry: geometry) }

    static func layout(_ presentation: Presentation, hovering: Bool, glance: Glance, geometry: NotchGeometry) -> IslandLayout {
        let notch = geometry.notch
        switch presentation {
        case .open:
            return IslandLayout(width: geometry.openWidth, height: notch.height + geometry.openHeight, shoulder: 14, corner: 32, lifted: true)
        case .banner:
            return IslandLayout(width: bannerWidth, height: notch.height + bannerHeight, shoulder: 10, corner: 24, lifted: true)
        case .resting:
            if glance.isEmpty && !hovering {
                // Just inside a hardware notch, so nothing shows; it grows out from there.
                // Without one it is a small notch of its own: the app has no other way in.
                return IslandLayout(width: notch.width - 12, height: notch.height - 4, shoulder: 0, corner: 8)
            }
            let wing = glance.isEmpty ? wing * 0.75 : wing
            var layout = IslandLayout(width: notch.width + 2 * wing, height: notch.height, shoulder: 6, corner: 12)
            if hovering {
                // Swells under the pointer, as if it noticed.
                layout.width += 14
                layout.height += 5
                layout.corner += 2
            }
            return layout
        }
    }

    /// The island's frame in global screen coordinates, for hit-testing the pointer.
    var frame: NSRect {
        let layout = layout
        return NSRect(
            x: geometry.centerX - layout.frameWidth / 2,
            y: geometry.top - layout.height,
            width: layout.frameWidth,
            height: layout.height
        )
    }
}
