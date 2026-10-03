import SwiftUI

// Every enum → label, colour and symbol mapping, in one place. Colour is reserved for
// meaning (PRODUCT.md): accent for live work, green only for verified outcomes, orange
// for "needs you", red for failure. Everything else is neutral.

// MARK: - Tone

extension Tone {
    /// live = accent, waiting = orange, success = green (verified outcomes only),
    /// failure = red, everything else neutral.
    var color: Color {
        switch self {
        case .live: .accentColor
        case .waiting: .orange
        case .success: .green
        case .failure: .red
        case .neutral, .unknown: .secondary
        }
    }

    /// Neutral lines read as secondary text; the others are worth the primary colour.
    var isQuiet: Bool { self == .neutral || self == .unknown }
}

// MARK: - Telemetry

extension Tone {
    /// Stacking order in the alert chart, bottom up: what matters sits on the baseline.
    static let chartOrder: [Tone] = [.failure, .waiting, .live, .success, .neutral]

    /// An alert's outcome, as the chart legend names it.
    var metricLabel: String {
        switch self {
        case .live: "Agent"
        case .waiting: "Needs you"
        case .success: "Resolved"
        case .failure: "Failed"
        case .neutral, .unknown: "Other"
        }
    }

    var metricHelp: String {
        switch self {
        case .live: "An agent is working on it"
        case .waiting: "Waiting on you"
        case .success: "Fixed and verified"
        case .failure: "The agent failed"
        case .neutral, .unknown: "Filtered, ignored, dismissed, or closed without a fix"
        }
    }

    /// Neutral recedes in charts: a quiet gray under the coloured outcomes.
    var chartColor: Color {
        isQuiet ? Color.secondary.opacity(0.4) : color
    }
}

// MARK: - Sessions

extension Session.State {
    var label: String {
        switch self {
        case .queued: "Queued"
        case .preparing: "Preparing worktree"
        case .running: "Running"
        case .waiting: "Waiting on you"
        case .ci: "Waiting on CI"
        case .awaiting_merge: "Ready to merge"
        case .awaiting_release: "Ready to release"
        case .deploying: "Deploying"
        case .resolved: "Resolved"
        case .closed: "Closed"
        case .failed: "Failed"
        case .stopped: "Stopped"
        case .unknown: "Unknown"
        }
    }
}

extension Session {
    /// What it is doing now, or for a finished session the honest outcome.
    var statusDetail: String {
        isActive ? activity : (resolutionLine ?? "")
    }

    /// A finished session's resolution, unless its headline already says it
    /// ("Closed · root cause not found" over "root cause not found").
    var resolutionLine: String? {
        guard let resolution, !resolution.isEmpty, !headline.localizedCaseInsensitiveContains(resolution) else { return nil }
        return resolution
    }

    /// "Opus · 12m · $1.40".
    func meta(now: Date) -> String {
        let end = isActive ? now : updatedAt
        return [model, Format.duration(from: startedAt, to: end), Format.cost(costUsd)]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    /// From the daemon's CI step, never inferred from status.
    var ciText: String {
        let rounds = ciRounds == 1 ? "1 round" : "\(ciRounds) rounds"
        let state: String
        switch steps.first(where: { $0.key == .ci })?.state {
        case .done?: state = "Passed"
        case .current?: state = "Running"
        case .failed?: state = "Failed"
        case .skipped?: state = "Not needed"
        default: state = ciRounds > 0 ? "Not passed" : "Not run"
        }
        return ciRounds > 0 ? "\(state) · \(rounds)" : state
    }
}

// MARK: - Steps

extension Step.State {
    /// For tooltips and VoiceOver. A stopped step is "failed" only when the session's
    /// tone says so; a closed or stopped session merely stopped there.
    func describe(tone: Tone) -> String {
        switch self {
        case .done: "done"
        case .current: tone == .waiting ? "waiting on you" : "in progress"
        case .pending: "not reached"
        case .failed: tone == .failure ? "failed here" : "stopped here"
        case .skipped: "not needed"
        case .unknown: "unknown"
        }
    }

    var isEmphasized: Bool { self == .current || self == .failed }

    func labelStyle(stopTint: Color) -> AnyShapeStyle {
        switch self {
        case .current: AnyShapeStyle(.primary)
        case .done: AnyShapeStyle(.secondary)
        case .failed: AnyShapeStyle(stopTint)
        case .pending, .skipped, .unknown: AnyShapeStyle(.tertiary)
        }
    }
}

extension Tone {
    /// Where a session stopped: red only when the daemon calls it a failure; a closed or
    /// stopped session is gray.
    var stopTint: Color { self == .failure ? .red : .secondary }

    var stopSymbol: String { self == .failure ? "xmark.circle" : "minus.circle" }
}

// MARK: - Triage

extension Triage.Decision {
    /// What Jev (or a rule) decided, as a short label.
    var callLabel: String {
        switch self {
        case .filtered: "Filtered by a rule"
        case .ignore: "Ignore"
        case .suggest: "Suggest an agent to you"
        case .auto: "Start an agent"
        case .escalate: "Needs you personally"
        case .pending: "Not triaged yet"
        case .unknown: "Unknown decision"
        }
    }
}

extension Jev {
    /// "build failure" from `build_failure`.
    var kindLabel: String { kind.replacingOccurrences(of: "_", with: " ") }

    var urgencyLabel: String { urgency.formatted(.number.precision(.fractionLength(1))) }
}

// MARK: - Alert outcome

/// The glyph for an alert's outcome in Recent. The daemon's `outcome.kind` decides; for a
/// session, its status refines it. The green check is reserved for `resolved`.
struct OutcomeGlyph {
    let symbol: String
    let style: AnyShapeStyle
    /// Nothing happened worth reading (filtered, ignored, dismissed, stopped).
    let dimmed: Bool

    init(_ outcome: AlertOutcome, session: Session?) {
        switch outcome.kind {
        case .pending: self.init("circle.dotted", .tertiary)
        case .filtered: self.init("line.3.horizontal.decrease", .tertiary, dimmed: true)
        case .ignored: self.init("minus.circle", .tertiary, dimmed: true)
        case .suggested: self.init("hand.raised", .secondary)
        case .escalated: self.init("person.fill.questionmark", .secondary)
        case .waiting: self.init("hand.raised.fill", .orange)
        case .dismissed: self.init("xmark.circle", .tertiary, dimmed: true)
        case .opened: self.init("arrow.up.right.circle", .secondary)
        case .session: self.init(session: session, tone: outcome.tone)
        case .unknown: self.init("questionmark.circle", .tertiary, dimmed: true)
        }
    }

    private init(session: Session?, tone: Tone) {
        switch session?.status {
        case .resolved?: self.init("checkmark.circle.fill", .green)
        // Closed by the user without a fix: neutral, never a success mark.
        case .closed?: self.init("minus.circle", .secondary)
        case .failed?: self.init("xmark.octagon", .red)
        case .stopped?: self.init("stop.circle", .secondary, dimmed: true)
        case nil, .unknown?:
            // The session has aged out of the snapshot: only its tone is known. Success is
            // the daemon's word for a verified outcome, the same fact as `resolved`.
            switch tone {
            case .success: self.init("checkmark.circle.fill", .green)
            case .failure: self.init("xmark.octagon", .red)
            case .live, .waiting: self.init("bolt.fill", tone.color)
            case .neutral, .unknown: self.init("minus.circle", .secondary)
            }
        default:
            // Live: accent while the agent works, orange while it waits on you.
            self.init("bolt.fill", tone == .waiting ? Tone.waiting.color : Tone.live.color)
        }
    }

    private init<S: ShapeStyle>(_ symbol: String, _ style: S, dimmed: Bool = false) {
        self.symbol = symbol
        self.style = AnyShapeStyle(style)
        self.dimmed = dimmed
    }
}

// MARK: - Actions

extension Action.Kind {
    var symbol: String {
        switch self {
        case .investigate: "magnifyingglass"
        case .merge: "arrow.triangle.merge"
        case .release: "shippingbox"
        case .rerun: "arrow.clockwise"
        case .answer: "bubble.left"
        case .grafana: "chart.xyaxis.line"
        case .review: "doc.text.magnifyingglass"
        case .reply: "arrowshape.turn.up.left"
        case .escalate: "person.fill.questionmark"
        case .unknown: "bell"
        }
    }

    /// Shown in place of the primary button while the daemon resolves the action.
    var progressLabel: String {
        switch self {
        case .merge: "Merging…"
        case .release: "Cutting the release…"
        case .rerun: "Re-running…"
        case .investigate: "Starting an agent…"
        case .reply, .answer: "Sending…"
        default: "Working…"
        }
    }
}

// MARK: - Transcript

extension TranscriptEntry.Kind {
    var prefix: String {
        switch self {
        case .tool: "› "
        case .status: "· "
        case .error: "! "
        default: ""
        }
    }

    var style: AnyShapeStyle {
        switch self {
        case .text, .result: AnyShapeStyle(.primary)
        case .tool: AnyShapeStyle(.secondary)
        case .status, .unknown: AnyShapeStyle(.tertiary)
        case .error: AnyShapeStyle(Color.red)
        }
    }

    /// Prose gets room; tool calls and status lines stay on one line.
    var lineLimit: Int {
        switch self {
        case .text, .result, .error: 6
        default: 1
        }
    }
}

// MARK: - Formatting

enum Format {
    /// "#alert-dev"; a direct message is named "DM" or "group DM" by the daemon and takes no `#`.
    static func channel(_ name: String) -> String {
        name == "DM" || name == "group DM" ? name : "#\(name)"
    }

    /// "now", "4m", "2h", "3d", then a short date.
    static func relative(_ date: Date, now: Date = .now) -> String {
        let s = max(0, now.timeIntervalSince(date))
        switch s {
        case ..<45: return "now"
        case ..<3600: return "\(Int((s / 60).rounded()))m"
        case ..<86_400: return "\(Int(s / 3600))h"
        case ..<(7 * 86_400): return "\(Int(s / 86_400))d"
        default: return date.formatted(.dateTime.month(.abbreviated).day())
        }
    }

    /// "just now", "4m ago", then a short date after a week.
    static func ago(_ date: Date, now: Date) -> String {
        let r = relative(date, now: now)
        if r == "now" { return "just now" }
        return now.timeIntervalSince(date) < 7 * 86_400 ? "\(r) ago" : r
    }

    /// "14:05" for history and transcript lines.
    static let clock: Date.FormatStyle = .dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)

    static func percent(_ v: Double) -> String { "\(Int((v * 100).rounded()))%" }

    static func duration(from start: Date, to end: Date) -> String {
        let s = Int(max(0, end.timeIntervalSince(start)))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m" }
        return "\(s / 3600)h \(s % 3600 / 60)m"
    }

    static func cost(_ usd: Double) -> String {
        usd.formatted(.currency(code: "USD").presentation(.narrow).precision(.fractionLength(2)))
    }

    /// "#4123" from a GitHub PR URL, else "".
    static func prLabel(_ url: String) -> String {
        if let n = url.split(separator: "/").last, Int(n) != nil { return "#\(n)" }
        return ""
    }
}
