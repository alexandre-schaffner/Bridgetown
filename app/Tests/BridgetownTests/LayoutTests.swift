import CoreGraphics
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
