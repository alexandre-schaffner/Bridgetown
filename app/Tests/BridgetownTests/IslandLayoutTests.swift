import CoreGraphics
import Testing
@testable import Bridgetown

@MainActor @Suite struct IslandLayoutTests {
    private let notched = NotchGeometry(
        top: 982, centerX: 756, notch: CGSize(width: 185, height: 32), hardware: true, openWidth: 1100, openHeight: 480
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
        #expect(idle.visible)
        #expect(!idle.lifted)
    }

    @Test func withoutANotchIdleIsInvisible() {
        var flat = notched
        flat.hardware = false
        #expect(!layout(.resting, geometry: flat).visible)
        #expect(layout(.resting, glance: Glance(working: 1), geometry: flat).visible)
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

    @Test func withoutANotchIdleLeavesTheMenuBarItsClicks() {
        var flat = notched
        flat.hardware = false
        let model = IslandModel(geometry: flat)
        #expect(!model.isTarget)
        model.glance = Glance(waiting: 1)
        #expect(model.isTarget)
        #expect(IslandModel(geometry: notched).isTarget)
    }

    @Test func troubleShowsEvenWithNothingRunning() {
        #expect(!Glance(trouble: true).isEmpty)
        #expect(Glance().isEmpty)
    }
}
