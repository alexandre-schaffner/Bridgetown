import CoreGraphics
import SwiftUI
import Testing
@testable import Bridgetown

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

    /// With the daemon away, a spinner on the last update would claim an agent still at work.
    @Test func marksHoldStillOverTheLastUpdate() {
        var environment = EnvironmentValues()
        environment.showsLastUpdate = true
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
    /// Recent's header with its bulk investigation action.
    private func width(proposed: CGFloat) -> CGFloat {
        let header = SelectionHeader(count: 2, total: 9, selectAll: {}, clear: {}) {
            Button("Investigate 2") {}.buttonStyle(.stage(.secondary))
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

@MainActor
@Suite struct ConfirmPromptTests {
    private func size(proposed width: CGFloat) -> CGSize {
        let prompt = ConfirmPrompt(question: "Close the session without a fix?", label: "Close session", isPresented: .constant(true)) {}
        return NSHostingController(rootView: prompt).sizeThatFits(in: CGSize(width: width, height: 200))
    }

    /// In a card in the narrowest column the question can't share a line with its buttons:
    /// it goes above them, rather than both being cut ("Close the session wit…", "Close…").
    @Test func aNarrowPromptStacksRatherThanCuts() {
        let narrow = size(proposed: 190)
        let wide = size(proposed: 600)
        #expect(narrow.width <= 190)
        #expect(narrow.height > wide.height)
    }
}

@Suite struct ClampCutTests {
    /// Lines 16pt tall with 2pt between them: an 18pt pitch, so a 4-line clamp is 72pt.
    private let pitch: CGFloat = 18
    private let spacing: CGFloat = 2

    private func run(_ y: CGFloat, lines: CGFloat, breaks: Bool = true) -> TextRun {
        TextRun(frame: CGRect(x: 0, y: y, width: 300, height: lines * pitch - spacing), breaksLines: breaks)
    }

    /// A review card: two lines of prose, "Ruled out:", then a list. The clamp used to end
    /// 72pt down whatever was there, through the middle of the list's first item.
    @Test func endsAfterTheLastWholeLineAboveTheLimit() {
        let runs = [run(0, lines: 2), run(41, lines: 1), run(64, lines: 1), run(84, lines: 1)]
        #expect(TextRun.cut(runs, limit: 72, pitch: pitch, spacing: spacing) == 57)
    }

    @Test func cutsAParagraphBetweenItsLines() {
        let runs = [run(0, lines: 6)]
        #expect(TextRun.cut(runs, limit: 72, pitch: pitch, spacing: spacing) == 70)
    }

    /// A code block or a heading can't end partway: the clamp ends above it.
    @Test func endsAboveABlockThatCannotBreak() {
        let runs = [run(0, lines: 2), run(44, lines: 4, breaks: false)]
        #expect(TextRun.cut(runs, limit: 72, pitch: pitch, spacing: spacing) == 34)
    }

    /// Before the first layout reports, or with one unbreakable block, the limit stands.
    @Test func fallsBackToTheLimit() {
        #expect(TextRun.cut([], limit: 72, pitch: pitch, spacing: spacing) == 72)
        #expect(TextRun.cut([run(0, lines: 6, breaks: false)], limit: 72, pitch: pitch, spacing: spacing) == 72)
    }
}
