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
        case .live: Ink.blue
        case .waiting: Ink.amber
        case .success: Ink.green
        case .failure: Ink.red
        case .neutral, .unknown: .secondary
        }
    }

    /// Neutral lines read as secondary text; the others are worth the primary colour.
    var isQuiet: Bool { self == .neutral || self == .unknown }
}

// MARK: - Grafana boards

extension Board.Panel.Unit {
    /// "1.2k", "423 ms", "0.9/s", "567 MB".
    func format(_ value: Double) -> String {
        switch self {
        case .ms:
            return value >= 1000 ? "\(Format.decimal(value / 1000, digits: 1)) s" : "\(Int(value.rounded())) ms"
        case .per_s:
            return "\(value.formatted(.number.precision(.significantDigits(1...2)).locale(Format.locale)))/s"
        case .bytes:
            return Format.bytes(value)
        case .count, .unknown:
            return Format.count(value)
        }
    }
}

extension Board {
    /// "per 30m": what one point of a count panel covers.
    var stepLabel: String {
        stepSeconds % 3600 == 0 ? "\(stepSeconds / 3600)h" : "\(max(1, stepSeconds / 60))m"
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
        case .critiquing: "In adversarial review"
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

    /// Who reviews the agent's fix: the other vendor's model.
    var reviewerName: String {
        switch critique?.reviewer {
        case .unknown?: "Reviewer"
        default: "Codex"
        }
    }

    /// From the daemon's review step and the last review. The step stays current for the
    /// whole loop, so only a `critiquing` session is being reviewed right now.
    var critiqueText: String {
        if status == .critiquing { return "Reviewing · round \(critiqueRounds + 1)" }
        let dropped = (critique?.dropped ?? 0) > 0 ? "\(critique?.dropped ?? 0) dropped by Jev" : nil
        let parts: [String?]
        switch steps.first(where: { $0.key == .critique })?.state {
        case .done?:
            parts = ["Passed", critiqueRounds == 1 ? "1 round of fixes" : critiqueRounds > 1 ? "\(critiqueRounds) rounds of fixes" : nil, dropped]
        case .skipped?:
            return "Not run"
        default:
            guard let critique, !critique.passed else { return "Not run" }
            parts = [critique.blocking == 1 ? "1 blocking finding" : "\(critique.blocking) blocking findings", dropped, status == .running ? "agent fixing" : nil]
        }
        return parts.compactMap { $0 }.joined(separator: " · ")
    }
}

// MARK: - Who has the next move

extension Session {
    /// Who an active session is waiting on. The tone can't tell: "In review" is live
    /// (in flight, not on you) yet no agent is working on it.
    enum Holder: CaseIterable {
        case agent, you, reviewers, ci, deploy, queue

        var label: String {
            switch self {
            case .agent: "working"
            case .you: "on you"
            case .reviewers: "in review"
            case .ci: "on CI"
            case .deploy: "deploying"
            case .queue: "queued"
            }
        }

        /// Something is progressing with no person involved: the agent, CI or a deploy.
        var isMoving: Bool { self == .agent || self == .ci || self == .deploy }
    }

    /// Nil once the session is finished.
    var holder: Holder? {
        switch status {
        case .preparing, .running, .critiquing: .agent
        case .waiting, .awaiting_merge, .awaiting_release: .you
        // CI green but the review request didn't go out: the daemon hands that to you.
        case .ci: reviewChannel != nil ? .reviewers : tone == .waiting ? .you : .ci
        case .deploying: .deploy
        case .queued: .queue
        case .resolved, .closed, .failed, .stopped, .unknown: nil
        }
    }

    /// "1 working · 2 in review", in `Holder` order, empty groups left out; the first
    /// `limit` groups when space is short.
    static func breakdown(_ sessions: [Session], limit: Int = .max) -> String {
        let holders = sessions.compactMap(\.holder)
        return Holder.allCases
            .compactMap { h in
                let n = holders.filter { $0 == h }.count
                return n > 0 ? "\(n) \(h.label)" : nil
            }
            .prefix(limit)
            .joined(separator: " · ")
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
    var stopTint: Color { self == .failure ? Ink.red : .secondary }

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

    var urgencyLabel: String { Format.decimal(urgency, digits: 1) }
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
        case .waiting: self.init("hand.raised.fill", Ink.amber)
        case .dismissed: self.init("xmark.circle", .tertiary, dimmed: true)
        case .opened: self.init("arrow.up.right.circle", .secondary)
        // Someone else owns it: worth reading, not yours to act on.
        case .teammate: self.init("person.fill", .secondary)
        case .session: self.init(session: session, tone: outcome.tone)
        case .unknown: self.init("questionmark.circle", .tertiary, dimmed: true)
        }
    }

    private init(session: Session?, tone: Tone) {
        switch session?.status {
        case .resolved?: self.init("checkmark.circle.fill", Ink.green)
        // Closed by the user without a fix: neutral, never a success mark.
        case .closed?: self.init("minus.circle", .secondary)
        case .failed?: self.init("xmark.octagon", Ink.red)
        case .stopped?: self.init("stop.circle", .secondary, dimmed: true)
        case nil, .unknown?:
            // The session has aged out of the snapshot: only its tone is known. Success is
            // the daemon's word for a verified outcome, the same fact as `resolved`.
            switch tone {
            case .success: self.init("checkmark.circle.fill", Ink.green)
            case .failure: self.init("xmark.octagon", Ink.red)
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
        case .error: AnyShapeStyle(Ink.red)
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
    /// Numbers follow the copy, which is English: "1.2k" and "$0.97", never "1,2k" or "0,97 $".
    static let locale = Locale(identifier: "en_US")

    /// "0.9", "2.3": at most `digits` decimals, no trailing zeros.
    static func decimal(_ value: Double, digits: Int) -> String {
        value.formatted(.number.precision(.fractionLength(0...digits)).rounded(rule: .toNearestOrAwayFromZero).locale(locale))
    }

    /// Memory in binary units, one decimal below 100: "567 MB", "35.3 GB".
    static func bytes(_ value: Double) -> String {
        let units = ["B", "KB", "MB", "GB", "TB", "PB"]
        var v = max(0, value)
        var i = 0
        while v >= 1024, i < units.count - 1 {
            v /= 1024
            i += 1
        }
        return "\(decimal(v, digits: i == 0 || v >= 100 ? 0 : 1)) \(units[i])"
    }

    /// A count as a person reads it: "4.5" and "21" below a thousand (a decimal only
    /// while it changes the reading), then "1.2k", "34k", "1.2M".
    static func count(_ value: Double) -> String {
        let v = abs(value)
        switch v {
        case 1_000_000...: return "\(decimal(value / 1_000_000, digits: v < 10_000_000 ? 1 : 0))M"
        case 1000...: return "\(decimal(value / 1000, digits: v < 10_000 ? 1 : 0))k"
        case 10...: return decimal(value.rounded(), digits: 0)
        default: return decimal(value, digits: 1)
        }
    }

    /// "#alert-dev"; a direct message is named "DM" or "group DM" by the daemon and takes no `#`.
    static func channel(_ name: String) -> String {
        name == "DM" || name == "group DM" || name == "Grafana" ? name : "#\(name)"
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
        usd.formatted(.currency(code: "USD").precision(.fractionLength(2)).locale(locale))
    }

    /// "#4123" from a GitHub PR URL, else "".
    static func prLabel(_ url: String) -> String {
        if let n = url.split(separator: "/").last, Int(n) != nil { return "#\(n)" }
        return ""
    }
}
