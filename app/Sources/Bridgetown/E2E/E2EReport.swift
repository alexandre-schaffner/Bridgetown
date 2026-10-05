#if DEBUG
import Foundation

/// A run's record: report.json for tools and agents, index.md to read. Written after
/// every shot, so a run that fails or is killed still leaves what it saw.
struct E2EReport: Encodable {
    struct Summary: Encodable {
        var shots = 0
        var errors = 0
        var warnings = 0
        var changed = 0
    }

    struct SideEffect: Encodable {
        /// The step that caused it, as `steps[12]` or `before[0]`.
        var step: String
        var kind: SystemActions.Effect
        var detail: String
    }

    struct Diff: Encodable {
        var baseline: String
        var changedPixels: Int
        var bbox: [Double]?
        /// diff/<shot>.png: changed pixels in red. Nil when the size changed.
        var png: String?
    }

    struct Shot: Encodable {
        var name: String
        var file: String
        var surface: String
        var size: [Double]
        var appearance: E2EAppearance
        var route: String
        var telemetry: String
        var png: String
        var settledMs: Int
        var settled: Bool
        var masked: Int
        var elements: Int
        var issues: [E2ELint.Issue]
        var diff: Diff?
    }

    var run: String
    var commit: String
    var os: String
    var scale = Double(E2ECapture.scale)
    var now: Date
    var suite: String
    var durationMs = 0
    var summary = Summary()
    /// Why the run stopped early (exit 2), naming the step.
    var failure: String?
    var sideEffects: [SideEffect] = []
    var shots: [Shot] = []

    mutating func add(_ shot: Shot) {
        shots.append(shot)
        summary.shots = shots.count
        summary.errors = shots.reduce(0) { $0 + $1.issues.filter { $0.severity == .error }.count }
        summary.warnings = shots.reduce(0) { $0 + $1.issues.filter { $0.severity == .warning }.count }
        summary.changed = shots.filter { $0.diff != nil }.count
    }

    var summaryLine: String {
        var parts = ["\(summary.shots) shots", "\(summary.errors) errors", "\(summary.warnings) warnings", "\(summary.changed) changed since baseline"]
        if let failure { parts.append("FAILED: \(failure)") }
        return parts.joined(separator: " · ")
    }

    func write(to dir: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(self).write(to: dir.appending(path: "report.json"))
        try Data(markdown.utf8).write(to: dir.appending(path: "index.md"))
    }

    var markdown: String {
        var out = ["# Bridgetown e2e · \(run)", "", "\(summaryLine) · \(durationMs / 1000)s · \(commit) · \(os) · clock \(now.formatted(.iso8601))", ""]
        let issues = shots.flatMap { shot in shot.issues.map { (shot, $0) } }
        let errors = issues.filter { $0.1.severity == .error }
        if !errors.isEmpty {
            out += ["## Errors", ""]
            out += errors.map { shot, issue in "- **\(issue.rule)** `\(shot.file)`: \(issue.message)\(Self.link(issue.crop, "crop"))" }
            out.append("")
        }
        let warnings = issues.filter { $0.1.severity == .warning }
        if !warnings.isEmpty {
            out += ["## Warnings", ""]
            for rule in Set(warnings.map(\.1.rule)).sorted() {
                let matching = warnings.filter { $0.1.rule == rule }
                out += ["### \(rule) (\(matching.count))", ""]
                // An element warns in every shot it is in: one line for it, with the first crop.
                let byElement = Dictionary(grouping: matching) { $0.1.identifier ?? $0.1.text ?? $0.1.message }
                for (element, found) in byElement.sorted(by: { ($0.value.count, $1.key) > ($1.value.count, $0.key) }) {
                    guard let (shot, issue) = found.first else { continue }
                    let more = found.count > 1 ? " and \(found.count - 1) more" : ""
                    out.append("- \"\(element.prefix(60))\": \(issue.message) · `\(shot.file)`\(more)\(Self.link(issue.crop, "crop"))")
                }
                out.append("")
            }
        }
        let changed = shots.filter { $0.diff != nil }
        if !changed.isEmpty {
            out += ["## Changed since baseline", ""]
            out += changed.compactMap { shot in
                shot.diff.map { "- `\(shot.file)`: \($0.changedPixels) px\($0.bbox.map { " in \($0.map { Int($0) })" } ?? " (size changed)")\(Self.link($0.png, "diff"))" }
            }
            out.append("")
        }
        out += ["## Shots", "", "| shot | surface | route | telemetry | issues | settled |", "|---|---|---|---|---|---|"]
        out += shots.map { shot in
            let counts = "\(shot.issues.filter { $0.severity == .error }.count) E · \(shot.issues.filter { $0.severity == .warning }.count) W"
            return "| [\(shot.file)](\(shot.png)) | \(shot.surface) | \(shot.route) | \(shot.telemetry) | \(counts) | \(shot.settled ? "\(shot.settledMs)ms" : "no") |"
        }
        out.append("")
        if !sideEffects.isEmpty {
            out += ["## Side effects (recorded, not performed)", ""]
            out += sideEffects.map { "- \($0.step): \($0.kind.rawValue) \($0.detail)" }
            out.append("")
        }
        return out.joined(separator: "\n")
    }

    private static func link(_ path: String?, _ label: String) -> String {
        path.map { " ([\(label)](\($0)))" } ?? ""
    }
}
#endif
