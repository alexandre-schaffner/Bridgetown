import SwiftUI

// Every enum → label, colour and symbol mapping, in one place. Colour is reserved for
// meaning (PRODUCT.md): blue for live work, green only for verified outcomes, amber for
// "needs you", red for failure. Everything else is neutral. Who has a session's next
// move, and the marks drawn from it, are in Views/Session/StepModel.swift.

// MARK: - Tone

extension Tone {
    /// live = blue, waiting = amber, success = green (verified outcomes only),
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
    func headline(_ headline: String) -> Text { Text(styledHeadline(headline)) }

    /// `headline`'s runs: only a coloured status word carries a colour of its own. A neutral
    /// one has none rather than a nil colour, which Text draws in the primary white.
    func styledHeadline(_ headline: String) -> AttributedString {
        var styled = AttributedString(headline)
        guard let color = wordColor else { return styled }
        let end = headline.range(of: " · ").map { headline.distance(from: headline.startIndex, to: $0.lowerBound) } ?? headline.count
        let word = styled.startIndex..<styled.index(styled.startIndex, offsetByCharacters: end)
        styled[word].foregroundColor = color
        return styled
    }
}

// MARK: - Sessions

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

    /// What the agent is doing, under the session's headline in its detail. Nil once it has
    /// ended (its resolution says how), and while it waits on you with its card shown under
    /// it: the agent's last words ("Asked: …", "ready to merge") would repeat the card.
    func activityLine(besideCard: Bool) -> String? {
        guard isActive, !activity.isEmpty, !(besideCard && holder == .you) else { return nil }
        return activity
    }

    /// How long it has run: up to `now` while active, up to its last update once it ended.
    func elapsed(now: Date) -> String {
        Format.duration(from: startedAt, to: isActive ? now : updatedAt)
    }

    /// "Opus · 12m · $1.40".
    func meta(now: Date) -> String {
        [model, elapsed(now: now), Format.cost(costUsd)]
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

extension AlertView {
    /// What opening `permalink` shows: a prod finding's is its Grafana dashboard.
    var permalinkLabel: String { source == .watch ? "Open in Grafana" : "Open in Slack" }
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
            // Live: blue while the agent works, amber while it waits on you.
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
        case .investigate: .investigate
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

    /// The agent behind it failed (a re-run, or a review of a failed session): marked red on
    /// its row, where every other meaning is left to the group's header.
    func failed(in snapshot: Snapshot?) -> Bool {
        kind == .rerun || (kind == .review && snapshot?.session(id: sessionId)?.tone == .failure)
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

    /// Prose gets room and the daemon's status lines two; a tool call stays on one line,
    /// whole in its tooltip.
    var lineLimit: Int {
        switch self {
        case .text, .result, .error: 6
        case .status: 2
        case .tool, .unknown: 1
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
