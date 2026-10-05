import CoreGraphics
import Testing
@testable import Bridgetown

/// The e2e layout lint on made-up accessibility trees: each rule fires on the layout it
/// names and stays quiet on the ordinary one next to it.
@Suite struct E2ELintTests {
    private let surface = CGSize(width: 400, height: 300)

    private func element(
        _ id: Int, _ frame: CGRect, role: String = "AXStaticText", parent: Int? = nil, scrollArea: Int? = nil,
        text: String? = nil, identifier: String? = nil, font: String? = nil
    ) -> E2EElement {
        let runs = font.map { [E2EElement.Run(location: 0, length: (text ?? "").utf16.count, font: $0, size: 13)] } ?? []
        return E2EElement(
            id: id, parent: parent, role: role, identifier: identifier, text: text, placeholder: nil,
            frame: frame, scrollArea: scrollArea, runs: runs
        )
    }

    private func rules(_ elements: [E2EElement], stage: Bool = true, allow: [E2EAllow] = []) -> [String] {
        E2ELint.lint(bounds: surface, elements: elements, options: E2ELint.Options(stage: stage, shot: "overview.dark", allow: allow)).map(\.rule)
    }

    // MARK: Bounds

    @Test func anElementPastTheEdgeIsOutOfBounds() {
        let group = element(0, CGRect(x: 350, y: 10, width: 80, height: 20), role: "AXGroup")
        #expect(rules([group]) == ["out-of-bounds"])
        #expect(rules([element(0, CGRect(x: 0, y: 0, width: 400, height: 300), role: "AXGroup")]).isEmpty)
    }

    @Test func textPastTheEdgeIsClippedRatherThanOutOfBounds() {
        #expect(rules([element(0, CGRect(x: 360, y: 10, width: 80, height: 16), text: "Merge #3345")]) == ["clipped-text"])
    }

    @Test func contentBelowAScrollViewportIsScrolledNotClipped() {
        let area = element(0, CGRect(x: 0, y: 0, width: 400, height: 300), role: "AXScrollArea")
        let cut = element(1, CGRect(x: 12, y: 290, width: 200, height: 16), parent: 0, scrollArea: 0, text: "Half a row")
        let below = element(2, CGRect(x: 12, y: 600, width: 200, height: 16), parent: 0, scrollArea: 0, text: "Far down")
        #expect(rules([area, cut, below]) == ["scrolled-out"])
    }

    @Test func textCutByTheSideOfItsScrollAreaIsClipped() {
        let area = element(0, CGRect(x: 0, y: 0, width: 200, height: 300), role: "AXScrollArea")
        let wide = element(1, CGRect(x: 12, y: 20, width: 240, height: 16), parent: 0, scrollArea: 0, text: "A title wider than its column")
        #expect(rules([area, wide]) == ["clipped-text"])
    }

    // MARK: Overlap

    @Test func overlappingTextIsAnError() {
        let a = element(0, CGRect(x: 10, y: 10, width: 100, height: 16), text: "Needs you")
        let b = element(1, CGRect(x: 60, y: 14, width: 100, height: 16), text: "Agents")
        let issues = E2ELint.lint(bounds: surface, elements: [a, b])
        #expect(issues.map(\.rule) == ["text-overlap"])
        #expect(issues.first?.elements == [0, 1])
    }

    @Test func linesClampedOutOfSightOverlapNothing() {
        // ClampedText's lines past "Show more" keep their frames, over the next row, and so
        // does the clip around them.
        let clip = element(0, CGRect(x: 0, y: 0, width: 300, height: 62), role: "AXGroup", identifier: ClampedText.clipIdentifier)
        let hiddenLine = element(1, CGRect(x: 0, y: 32, width: 300, height: 30), parent: 0, text: "Ruled out: the campaign config")
        let nextRow = element(2, CGRect(x: 0, y: 48, width: 300, height: 16), text: "Agent failed · Dispute bot")
        #expect(rules([clip, hiddenLine, nextRow]).isEmpty)
        let unclipped = element(1, CGRect(x: 0, y: 32, width: 300, height: 30), text: "Ruled out: the campaign config")
        #expect(rules([unclipped, nextRow]) == ["text-overlap"])
    }

    @Test func textThatTouchesOrNestsDoesNotOverlap() {
        let a = element(0, CGRect(x: 10, y: 10, width: 100, height: 16), text: "Needs you")
        let grazing = element(1, CGRect(x: 108.5, y: 10, width: 100, height: 16), text: "Agents")
        #expect(rules([a, grazing]).isEmpty)
        // A container's label sits over its own children; only leaves are compared.
        let row = element(2, CGRect(x: 0, y: 40, width: 300, height: 30), role: "AXGroup", text: "Merge fix(app)")
        let title = element(3, CGRect(x: 8, y: 46, width: 200, height: 16), parent: 2, text: "Merge fix(app)")
        #expect(rules([row, title]).isEmpty)
    }

    // MARK: Controls

    @Test func aControlWithNoSizeIsAnErrorUnlessItIsAScrollersOwn() {
        #expect(rules([element(0, CGRect(x: 10, y: 10, width: 0, height: 0), role: "AXButton", text: "Retry")]) == ["zero-size-control"])
        let scroller = element(0, CGRect(x: 390, y: 0, width: 10, height: 300), role: "AXScrollBar")
        let arrow = element(1, CGRect(x: 390, y: 0, width: 0, height: 0), role: "AXButton", parent: 0)
        #expect(rules([scroller, arrow]).isEmpty)
    }

    @Test func smallAndUnlabeledControlsAreWarnings() {
        let issues = E2ELint.lint(bounds: surface, elements: [element(0, CGRect(x: 10, y: 10, width: 14, height: 14), role: "AXButton")])
        #expect(issues.map(\.rule) == ["tiny-target", "unlabeled-control"])
        #expect(issues.allSatisfy { $0.severity == .warning })
    }

    @Test func systemControlsKeepTheirSizesAndTheirParts() {
        // A stepper: the system's size, and arrows that are its parts, unnamed.
        let stepper = element(0, CGRect(x: 10, y: 10, width: 11, height: 16), role: "AXIncrementor", text: "Concurrent sessions")
        let up = element(1, CGRect(x: 10, y: 10, width: 11, height: 8), role: "AXButton", parent: 0)
        #expect(rules([stepper, up], stage: false).isEmpty)
        // On the stage every control is the app's own.
        #expect(rules([stepper, up]) == ["tiny-target"])
    }

    @Test func aControlWhoseLabelDoesNotFitIsAnError() {
        let button = element(0, CGRect(x: 10, y: 10, width: 30, height: 22), role: "AXButton", text: "Cut indexer-v0.9.3", font: "Helvetica")
        #expect(rules([button], stage: false) == ["truncated-control"])
    }

    // MARK: Text

    @Test func clampedTextIsAWarning() {
        let clamped = element(0, CGRect(x: 10, y: 10, width: 60, height: 16), text: "merkl-api · 5xx rate 3.1% on /v4/opportunities", font: "Helvetica")
        let fits = element(1, CGRect(x: 10, y: 40, width: 300, height: 16), text: "Agents", font: "Helvetica")
        let issues = E2ELint.lint(bounds: surface, elements: [clamped, fits], options: E2ELint.Options(stage: false))
        #expect(issues.map(\.rule) == ["truncated"])
        #expect(issues.first?.severity == .warning)
    }

    @Test func onTheStageEveryRunIsGeist() {
        let fallback = element(0, CGRect(x: 10, y: 10, width: 300, height: 16), text: "→", font: "AppleSymbols")
        let geist = element(1, CGRect(x: 10, y: 40, width: 300, height: 16), text: "Agents", font: "Geist-Medium")
        #expect(rules([fallback, geist]) == ["font-fallback"])
        // Settings draws in the system font, as a Mac window should.
        #expect(rules([fallback], stage: false).isEmpty)
    }

    // MARK: Allowlist

    @Test func theAllowlistMatchesRuleIdentifierTextAndShot() {
        let clipped = element(0, CGRect(x: 360, y: 10, width: 80, height: 16), text: "Merge #3345", identifier: "needsYou.row.a")
        let byIdentifier = E2EAllow(rule: "clipped-text", identifier: "needsYou.row.a", why: "known")
        let byText = E2EAllow(rule: "clipped-text", text: "^Merge", shots: "overview.*", why: "known")
        let otherShot = E2EAllow(rule: "clipped-text", shots: "session-*", why: "elsewhere")
        let otherRule = E2EAllow(rule: "text-overlap", why: "another rule")
        #expect(rules([clipped], allow: [byIdentifier]).isEmpty)
        #expect(rules([clipped], allow: [byText]).isEmpty)
        #expect(rules([clipped], allow: [otherShot, otherRule]) == ["clipped-text"])
    }

    @Test func globsMatchWholeNames() {
        #expect(E2EGlob.matches("card-*", "card-a_mock_merge"))
        #expect(E2EGlob.matches("notch-?lat*", "notch-flat-glance"))
        #expect(!E2EGlob.matches("card", "card-a_mock_merge"))
        #expect(!E2EGlob.matches("session.*", "sessionXdark"))
    }
}
