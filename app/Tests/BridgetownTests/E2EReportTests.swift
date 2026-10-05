import Foundation
import Testing
@testable import Bridgetown

/// The run's record as index.md and the summary line read it.
@Suite struct E2EReportTests {
    private func shot(_ name: String, diff: E2EReport.Diff?) -> E2EReport.Shot {
        E2EReport.Shot(
            name: name, file: "\(name).dark", surface: "open/wide", size: [1100, 512], appearance: .dark,
            route: "overview", telemetry: "Incidents", png: "shots/\(name).dark.png", settledMs: 300, settled: true,
            masked: 0, elements: 10, issues: [], diff: diff
        )
    }

    @Test func aShotTheBaselineLacksIsSaidSoRatherThanCountedAsChangedOrNot() {
        var report = E2EReport(run: "r", commit: "c", os: "macOS", now: .now, suite: "suite.json")
        report.add(shot("same", diff: nil))
        report.add(shot("moved", diff: E2EReport.Diff(baseline: "b/shots/moved.dark.png", changedPixels: 40, bbox: [0, 0, 10, 2], png: "diff/moved.dark.png")))
        report.add(shot("new", diff: E2EReport.Diff(baseline: "b/shots/new.dark.png", changedPixels: 0, bbox: nil, png: nil, missing: true)))

        #expect(report.summary.changed == 1)
        #expect(report.summary.missing == 1)
        #expect(report.summaryLine.contains("1 changed since baseline · 1 not in the baseline"))
        #expect(report.markdown.contains("- `new.dark`: not in the baseline"))
        #expect(report.markdown.contains("- `moved.dark`: 40 px in [0, 0, 10, 2]"))
    }
}
