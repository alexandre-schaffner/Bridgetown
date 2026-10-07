import AppKit
import SwiftUI
import Testing
@testable import Bridgetown

@MainActor @Suite struct IslandLayoutTests {
    private let notched = NotchGeometry(
        top: 982, centerX: 756, notch: CGSize(width: 185, height: 32), openWidth: 1100, openHeight: 480
    )

    private func layout(
        _ presentation: IslandModel.Presentation, hovering: Bool = false, glance: Glance = Glance(), geometry: NotchGeometry? = nil
    ) -> IslandLayout {
        IslandModel.layout(presentation, hovering: hovering, glance: glance, geometry: geometry ?? notched)
    }

    @Test func idleHidesInsideTheNotch() {
        let idle = layout(.resting)
        #expect(idle.frameWidth < notched.notch.width)
        #expect(idle.height < notched.notch.height)
        #expect(!idle.lifted)
    }

    @Test func wingsFlankTheNotchAtMenuBarHeight() {
        let busy = layout(.resting, glance: Glance(working: 2, waiting: 1))
        #expect(busy.width == notched.notch.width + 2 * IslandModel.wing)
        #expect(busy.height == notched.notch.height)
    }

    @Test func hoverSwells() {
        let glance = Glance(waiting: 3)
        let rest = layout(.resting, glance: glance)
        let hover = layout(.resting, hovering: true, glance: glance)
        #expect(hover.width > rest.width)
        #expect(hover.height > rest.height)
        // Even with nothing to show, hovering the notch brings the island out.
        #expect(layout(.resting, hovering: true).width > notched.notch.width)
    }

    @Test func openIsWideAndLifted() {
        let open = layout(.open, hovering: true, glance: Glance(working: 1))
        #expect(open.width == notched.openWidth)
        #expect(open.height == notched.notch.height + notched.openHeight)
        #expect(open.width > open.height)
        #expect(open.lifted)
    }

    /// Without a notch nothing hides it: the idle island is the app's only way in, so it
    /// keeps a frame under the top edge to point at and press.
    @Test func idleWithoutANotchStaysWhereThePointerCanReachIt() {
        let flat = NotchGeometry(top: 900, centerX: 720, notch: CGSize(width: NotchGeometry.standInWidth, height: 24), openWidth: 1100, openHeight: 480)
        let model = IslandModel(geometry: flat)
        #expect(model.glance.isEmpty && model.presentation == .resting)
        #expect(model.frame.width > 100 && model.frame.height > 10)
        #expect(model.frame.maxY == flat.top)
        #expect(model.frame.contains(CGPoint(x: flat.centerX, y: flat.top - 2)))
    }

    /// The wings are centred on the notch only while both take their width; the idle
    /// island, narrower than the notch, then shows neither.
    @Test func emptyWingsKeepTheirWidth() {
        for glance in [Glance(), Glance(working: 1), Glance(trouble: true)] {
            let wings = NSHostingView(rootView: GlanceWings(glance: glance, notch: notched.notch, hovering: false))
            #expect(wings.fittingSize.width == notched.notch.width + 2 * IslandModel.wing)
        }
    }

    @Test func troubleShowsEvenWithNothingRunning() {
        #expect(!Glance(trouble: true).isEmpty)
        #expect(Glance().isEmpty)
    }
}
