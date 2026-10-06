import CoreGraphics
import SwiftUI
import Testing
@testable import Bridgetown

@Suite struct StepFlowTests {
    @Test func leftoverRoomIsSharedByTheHairlines() {
        // 300 - 200 = 100 left over, shared by the four columns before the last.
        let widths = StepFlow.widths(minimums: [60, 30, 30, 40, 40], total: 300)
        #expect(widths == [85, 55, 55, 65, 40])
    }

    /// Squeezed, pills would slide over each other; the row reports its true width instead,
    /// so `StepFits` falls back to a narrower style.
    @Test func neverGoesBelowTheMinimums() {
        #expect(StepFlow.widths(minimums: [100, 100], total: 100) == [100, 100])
    }

    @Test func aLoneColumnTakesTheWidth() {
        #expect(StepFlow.widths(minimums: [40], total: 120) == [120])
    }

    @Test func unspecifiedWidthUsesMinimums() {
        #expect(StepFlow.widths(minimums: [10, 20], total: nil) == [10, 20])
    }
}

@Suite struct FlowLayoutTests {
    private let chip = CGSize(width: 50, height: 20)

    @Test func wrapsWhenTheNextChipWouldOverflow() {
        let rows = FlowLayout.rows(sizes: [chip, chip, chip], width: 110, spacing: 6)
        #expect(rows.map(\.indices) == [[0, 1], [2]])
        #expect(rows[0].width == 106)
        #expect(rows[0].height == 20)
    }

    @Test func oversizedChipGetsARowOfItsOwn() {
        let rows = FlowLayout.rows(sizes: [CGSize(width: 200, height: 24), chip], width: 100, spacing: 6)
        #expect(rows.map(\.indices) == [[0], [1]])
        #expect(rows[0].height == 24)
    }

    @Test func noChipsNoRows() {
        #expect(FlowLayout.rows(sizes: [], width: 100, spacing: 6).isEmpty)
    }
}

@Suite struct LiveMarksTests {
    @Test func marksHoldStillOutOfSight() {
        var environment = EnvironmentValues()
        #expect(!environment.marksHoldStill)
        environment.outOfSight = true
        #expect(environment.marksHoldStill)
    }
}

@MainActor
@Suite struct PaneFollowTests {
    /// A pane 400pt tall over 1000pt of content.
    private func tracker(scrolledTo offset: CGFloat) -> ScrollTracker {
        let tracker = ScrollTracker()
        tracker.update(offset: offset, content: 1000, viewport: 400)
        return tracker
    }

    @Test func atItsEndItFollowsWhatGrows() {
        #expect(tracker(scrolledTo: 600).follows(growingTo: 1040))
    }

    /// Read higher up, a pane stays where it is read; and what shrinks needs no following.
    @Test func elsewhereOrShrinkingItStaysPut() {
        #expect(!tracker(scrolledTo: 300).follows(growingTo: 1040))
        #expect(!tracker(scrolledTo: 600).follows(growingTo: 960))
    }

    /// Content that fits has no end to keep to: it opens at its top as it grows.
    @Test func contentThatFitsHasNoEndToFollow() {
        let tracker = ScrollTracker()
        tracker.update(offset: 0, content: 300, viewport: 400)
        #expect(!tracker.follows(growingTo: 500))
    }
}

@MainActor
@Suite struct SelectionHeaderTests {
    /// Recent's header: Investigate, and the Rate menu, which is fixed to its size.
    private func width(proposed: CGFloat) -> CGFloat {
        let header = SelectionHeader(count: 2, total: 9, selectAll: {}, clear: {}) {
            Button("Investigate 2") {}.buttonStyle(.stage(.secondary))
            Button("Rate") {}.buttonStyle(.stage(.secondary)).fixedSize()
        }
        return NSHostingController(rootView: header).sizeThatFits(in: CGSize(width: proposed, height: 100)).width
    }

    /// Wider than its column, the header would widen every list under it past the island's
    /// edge; it gives up "Select all" and the word "selected" instead, and squeezes its
    /// actions last. 218pt is the overview's narrowest column, on a 1024pt-wide screen.
    @Test func keepsToItsColumn() {
        #expect(width(proposed: 218) <= 218)
        #expect(width(proposed: 160) <= 160)
    }
}
