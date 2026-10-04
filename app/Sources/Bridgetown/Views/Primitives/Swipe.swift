import AppKit
import SwiftUI

/// Two-finger horizontal swipes on the trackpad, as in Safari: fingers moving right go
/// back, fingers moving left go forward. One swipe, one step, whatever its length.
enum SwipeDirection {
    /// Fingers moved right: back, or the previous tab.
    case back
    /// Fingers moved left: the next tab.
    case forward
}

extension View {
    /// Calls `perform` for a horizontal two-finger swipe over this view; the innermost
    /// view under the pointer that has one gets it. Return false to let it pass (nothing to
    /// go back to). Vertical scrolling is untouched: a swipe has to be mostly sideways.
    func onHorizontalSwipe(_ perform: @escaping (SwipeDirection) -> Bool) -> some View {
        background(SwipeArea(perform: perform))
    }
}

private struct SwipeArea: NSViewRepresentable {
    let perform: (SwipeDirection) -> Bool

    func makeNSView(context: Context) -> SwipeAreaView {
        let view = SwipeAreaView()
        view.perform = perform
        return view
    }

    func updateNSView(_ view: SwipeAreaView, context: Context) {
        view.perform = perform
    }
}

/// Registers itself with the monitor while in a window. It never takes a click.
final class SwipeAreaView: NSView {
    var perform: ((SwipeDirection) -> Bool)?

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { SwipeMonitor.shared.remove(self) } else { SwipeMonitor.shared.add(self) }
    }
}

/// One local scroll-wheel monitor for every swipe area. It reads the gesture without
/// consuming it, so scroll views still get every event.
@MainActor
final class SwipeMonitor {
    static let shared = SwipeMonitor()

    /// Sideways travel, in points, that makes a swipe.
    private static let threshold: CGFloat = 56

    private var areas: [ObjectIdentifier: WeakArea] = [:]
    private var monitor: Any?
    private var travel: CGFloat = 0
    /// The gesture already did its step (or was vertical): ignore the rest of it.
    private var spent = false

    private struct WeakArea {
        weak var view: SwipeAreaView?
    }

    func add(_ view: SwipeAreaView) {
        areas[ObjectIdentifier(view)] = WeakArea(view: view)
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            MainActor.assumeIsolated { SwipeMonitor.shared.handle(event) }
            return event
        }
    }

    func remove(_ view: SwipeAreaView) {
        areas[ObjectIdentifier(view)] = nil
    }

    private func handle(_ event: NSEvent) {
        // Trackpad gestures only (a mouse wheel has no phases), and not their momentum.
        guard event.hasPreciseScrollingDeltas, event.momentumPhase.isEmpty else { return }
        if event.phase.contains(.began) {
            travel = 0
            spent = false
        }
        guard !spent, event.phase.contains(.changed) else { return }
        let dx = event.scrollingDeltaX
        let dy = event.scrollingDeltaY
        // A gesture that starts out vertical is a scroll, start to finish.
        if travel == 0, abs(dy) > abs(dx) {
            spent = true
            return
        }
        travel += dx
        guard abs(travel) >= Self.threshold else { return }
        spent = true
        // With natural scrolling the deltas follow the fingers; without, they are reversed.
        let fingersRight = event.isDirectionInvertedFromDevice ? travel > 0 : travel < 0
        let direction: SwipeDirection = fingersRight ? .back : .forward
        // Innermost first; one with nothing to do (the last tab) passes it outward.
        for area in targets(for: event) where area.perform?(direction) == true { return }
    }

    /// The registered areas under the pointer in the event's window, smallest first.
    private func targets(for event: NSEvent) -> [SwipeAreaView] {
        areas = areas.filter { $0.value.view != nil }
        return areas.values
            .compactMap(\.view)
            .filter { $0.window === event.window && $0.bounds.contains($0.convert(event.locationInWindow, from: nil)) }
            .sorted { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }
    }
}
