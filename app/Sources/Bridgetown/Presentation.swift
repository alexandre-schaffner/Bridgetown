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

    /// A status word in a row's detail ("Waiting on you", "Failed") in its tone, so what
    /// happened reads first. Nil for neutral words, which keep the line's grey. The word
    /// says it either way: colour is never the only cue.
    var wordColor: Color? {
        switch self {
        case .live, .waiting, .success, .failure: color
        case .neutral, .unknown: nil
        }
    }

    /// `headline` with its status word, the part before the first " · ", in this tone,
    /// and the rest ("root cause not found", "#product-approvals") left in the line's grey.
    func headline(_ headline: String) -> Text {
        guard let split = headline.range(of: " · ") else {
            return Text(headline).foregroundColor(wordColor)
        }
        return Text(headline[..<split.lowerBound]).foregroundColor(wordColor)
            + Text(headline[split.lowerBound...])
    }
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

extension Board.Panel {
    /// The window's usual level, the median of its one series; nil for several series,
    /// an empty window or a median of zero.
    var typical: Double? {
        guard series.count == 1, let median = Self.median(series[0].points.compactMap { $0.count == 2 ? $0[1] : nil })
        else { return nil }
        return median > 0 ? median : nil
    }

    private static func median(_ values: [Double]) -> Double? {
        let values = values.sorted()
        guard !values.isEmpty else { return nil }
        let mid = values.count / 2
        return values.count.isMultiple(of: 2) ? (values[mid - 1] + values[mid]) / 2 : values[mid]
    }

    struct Sample: Equatable {
        var at: Date
        var value: Double
    }

    /// The window at a glance, over the series summed at each timestamp (as `latest` is).
    struct Summary: Equatable {
        /// The highest bucket, the first if several tie.
        var peak: Sample
        var low: Sample
        var median: Double
        /// Every bucket added up: for a count, how many in the window.
        var total: Double
    }

    /// Nil when the panel failed or has no samples.
    var summary: Summary? {
        var sums: [Double: Double] = [:]
        for s in series {
            for p in s.points where p.count == 2 { sums[p[0], default: 0] += p[1] }
        }
        let totals = sums.sorted { $0.key < $1.key }.map { Sample(at: Date(timeIntervalSince1970: $0.key), value: $0.value) }
        guard error == nil,
              let peak = totals.max(by: { $0.value < $1.value }),
              let low = totals.min(by: { $0.value < $1.value }),
              let median = Self.median(totals.map(\.value))
        else { return nil }
        return Summary(peak: peak, low: low, median: median, total: totals.reduce(0) { $0 + $1.value })
    }

    /// A series' value nearest `date`, or its last when `date` is nil.
    static func value(of series: Series, at date: Date?) -> Double? {
        guard let date else { return series.points.last?.last }
        let t = date.timeIntervalSince1970
        return series.points.min { abs($0[0] - t) < abs($1[0] - t) }?.last
    }

    /// Well above usual: at least 1.8× the median, and more than one over it.
    static func isSpike(_ value: Double, typical: Double?) -> Bool {
        guard let typical else { return false }
        return value >= max(typical * 1.8, typical + 1)
    }

    /// How unusual the latest value is, as a multiple of the median, when it spikes.
    var spikeRatio: Double? {
        guard error == nil, let latest, let typical, Self.isSpike(latest, typical: typical) else { return nil }
        return latest / typical
    }
}

extension Board {
    /// The panel to lead with: the one spiking hardest, or else the board's first.
    var lead: Board.Panel? {
        panels.filter { $0.spikeRatio != nil }.max { ($0.spikeRatio ?? 0) < ($1.spikeRatio ?? 0) } ?? panels.first
    }

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

    /// What there is to show for a step, under its name in the stepper: "Cause found",
    /// "#3340", the reviewer's result, "Running · 1 round". Only what the daemon has
    /// evidence for; nil where it has none, and for steps not reached.
    func evidence(for step: Step) -> String? {
        guard step.state != .pending, step.state != .unknown else { return nil }
        switch step.key {
        case .diagnose:
            return rootCauseFound.map { $0 ? "Cause found" : "No root cause" }
        case .pr:
            return prUrl.map(Format.prLabel).flatMap { $0.isEmpty ? nil : $0 }
        case .critique:
            return critiqueLine.flatMap { $0.isEmpty ? nil : $0 }
        case .ci:
            return ciRounds > 0 || step.state == .current ? ciText : nil
        case .fix, .deploy, .unknown:
            return nil
        }
    }

    /// The CI line's colour, from the same step: green once it passed, blue while it
    /// runs, red when it failed; grey otherwise.
    var ciColor: Color? {
        switch steps.first(where: { $0.key == .ci })?.state {
        case .done?: Ink.green
        case .current?: Ink.blue
        case .failed?: Ink.red
        default: nil
        }
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

// MARK: - Who has the next move

extension Session {
    /// Who an active session is waiting on. The tone can't tell: "In review" is live
    /// (in flight, not on you) yet no agent is working on it.
    enum Holder: CaseIterable {
        case agent, critic, you, reviewers, ci, deploy, queue

        var label: String {
            switch self {
            case .agent: "working"
            case .critic: "in adversarial review"
            case .you: "on you"
            case .reviewers: "in review"
            case .ci: "on CI"
            case .deploy: "deploying"
            case .queue: "queued"
            }
        }

        /// Something is progressing with no person involved: the agent, the adversarial review, CI or a deploy.
        var isMoving: Bool { self == .agent || self == .critic || self == .ci || self == .deploy }
    }

    /// Nil once the session is finished.
    var holder: Holder? {
        switch status {
        case .preparing, .running: .agent
        case .critiquing: .critic
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

extension AlertOutcome {
    /// Nothing was done and nothing is owed: a rule filtered it, or Jev ignored it. Recent
    /// folds these away.
    var isQuiet: Bool { kind == .filtered || kind == .ignored }
}

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
        case .withdrawn: self.init("arrow.uturn.backward.circle", .tertiary, dimmed: true)
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

/// The decision an action asks for. "Needs you" lists actions under these, so a row
/// doesn't repeat what its group already says.
enum ActionGroup: CaseIterable {
    /// Someone is waiting on an answer: a teammate, an agent, or a call only you can make.
    case answer
    /// A verified fix is ready to merge or release.
    case ship
    /// A new incident or prod signal no agent has picked up.
    case investigate
    /// An agent ended without a fix: retry it, or close the session.
    case retry

    var title: String {
        switch self {
        case .answer: "Answer"
        case .ship: "Ship"
        case .investigate: "Investigate"
        case .retry: "Retry or close"
        }
    }

    var symbol: String {
        switch self {
        case .answer: "bubble.left"
        case .ship: "arrow.triangle.merge"
        case .investigate: "magnifyingglass"
        case .retry: "arrow.clockwise"
        }
    }

    /// The meanings colour has everywhere else: green for a verified fix, amber for
    /// someone or something waiting on you. Retries stay neutral, since they mix agents
    /// that failed (marked red on their rows) with sessions that merely ended.
    var tint: Color? {
        switch self {
        case .ship: Ink.green
        case .answer, .investigate: Ink.amber
        case .retry: nil
        }
    }
}

extension Action.Kind {
    var group: ActionGroup {
        switch self {
        case .escalate, .reply, .answer, .unknown: .answer
        case .merge, .release: .ship
        case .investigate, .grafana: .investigate
        case .review, .rerun: .retry
        }
    }
}

extension Action {
    /// Its primary button needs nothing typed or chosen, so a row can offer it as is.
    var isOneClick: Bool {
        switch kind {
        case .reply, .answer: false
        default: options.isEmpty
        }
    }
}

extension [Action] {
    /// The primary button these share, to press on all of them at once: the same kind and
    /// label, nothing to type or choose, and nothing to open (a browser tab per row is not
    /// a bulk action). Nil when they differ, or one is already being resolved.
    var sharedPrimary: String? {
        guard let first else { return nil }
        let shared = allSatisfy {
            $0.kind == first.kind && $0.primaryLabel == first.primaryLabel && $0.isOneClick && $0.url == nil && !$0.inFlight
        }
        return shared ? first.primaryLabel : nil
    }
}

extension Snapshot {
    /// `sortedActions` under their groups, in `ActionGroup` order; empty groups left out.
    var actionGroups: [(group: ActionGroup, actions: [Action])] {
        let sorted = sortedActions
        return ActionGroup.allCases.compactMap { group in
            let actions = sorted.filter { $0.kind.group == group }
            return actions.isEmpty ? nil : (group, actions)
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

// MARK: - Log sweep

extension LogSweep.Pattern {
    /// "New error", "Surging error · 55×", "Risky warning", "Steady error".
    var headline: String {
        let noun = level == .warning ? "warning" : "error"
        switch behaviour {
        case .new: return "New \(noun)"
        case .surging:
            let times = usual > 0 ? Int((recent / usual).rounded()) : 0
            return times > 1 ? "Surging \(noun) · \(times)×" : "Surging \(noun)"
        case .steady, .unknown: return level == .warning ? "Risky warning" : "Steady error"
        }
    }

    /// "merkl-compute-*", or "merkl-precompute-* +1".
    var sourcesLabel: String {
        guard let first = sources.first else { return "unknown" }
        return sources.count > 1 ? "\(first) +\(sources.count - 1)" : first
    }

    /// Jev's verdict in one line; "Not asked yet" for a suspicious pattern Jev hasn't
    /// judged, nil for the steady noise it is never asked about.
    var verdictLine: String? {
        if let jev {
            return "Jev · problem \(Format.percent(jev.problem)) · agent \(Format.percent(jev.agent)) · users \(Format.percent(jev.users))"
        }
        return suspicious ? "Not asked yet" : nil
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
