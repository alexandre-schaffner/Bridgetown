import CoreGraphics
import Testing
@testable import Bridgetown

@Suite struct StepColumnsTests {
    @Test func equalSharesWhenEverythingFits() {
        let widths = StepColumns.widths(ideals: [40, 30, 20, 20, 50], total: 312, spacing: 3)
        #expect(widths == Array(repeating: 60, count: 5))
    }

    @Test func wideLabelKeepsItsIdealOthersShareTheRest() {
        // "Root cause?" needs 90; the rest split 300 - 12 - 90 = 198 four ways.
        let widths = StepColumns.widths(ideals: [90, 30, 20, 20, 30], total: 300, spacing: 3)
        #expect(widths == [90, 49.5, 49.5, 49.5, 49.5])
    }

    @Test func scalesDownWhenIdealsDontFit() {
        let widths = StepColumns.widths(ideals: [100, 100], total: 103, spacing: 3)
        #expect(widths == [50, 50])
    }

    @Test func unspecifiedWidthUsesIdeals() {
        #expect(StepColumns.widths(ideals: [10, 20], total: nil, spacing: 3) == [10, 20])
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
