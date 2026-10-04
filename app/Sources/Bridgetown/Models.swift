import Foundation

// Codable mirrors of docs/API.md. Every nullable field is always present on the wire,
// so optionals here decode `null` and are never missing.
//
// String enums decode leniently: an unrecognised value maps to `.unknown` instead of
// failing the whole Snapshot, so a newer daemon can't blank the menu bar app.
//
// Labels, colours and symbols for these types live in Presentation.swift.

protocol LenientStringEnum: Codable, RawRepresentable, Sendable, Hashable where RawValue == String {
    static var unknown: Self { get }
}

extension LenientStringEnum {
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

// MARK: - Snapshot

struct Snapshot: Codable, Sendable, Equatable {
    var status: Status
    var actions: [Action]
    var sessions: [Session]
    var alerts: [AlertView]
    /// Nil from a daemon older than the telemetry panel.
    var metrics: Telemetry?
    var settings: Settings
}

// MARK: - Telemetry

/// The overview's numbers over the last day, counted by the daemon from its whole store.
struct Telemetry: Codable, Sendable, Equatable {
    /// Sessions started in the window.
    struct Sessions: Codable, Sendable, Equatable {
        var started: Int
        var resolved: Int
        var failed: Int
        /// Closed or stopped without a verified fix.
        var closed: Int
        var costUsd: Double
    }

    var since: Date
    var sessions: Sessions
}

// MARK: - Grafana boards

/// A small Grafana dashboard (`GET /boards/:view`, `GET /alerts/:id/board`), read by the
/// daemon through the local grafana MCP container.
struct Board: Codable, Sendable, Equatable {
    struct Panel: Codable, Sendable, Equatable, Identifiable {
        enum Unit: String, LenientStringEnum { case count, ms, per_s, bytes, unknown }

        struct Series: Codable, Sendable, Equatable {
            var label: String
            /// `[unix seconds, value]`, oldest first.
            var points: [[Double]]
        }

        var id: String
        var title: String
        var unit: Unit
        var series: [Series]
        /// The sum of each series' last point.
        var latest: Double?
        /// The Grafana dashboard over the board's window, opened in the browser.
        var link: String
        /// This panel's query failed; the others still show.
        var error: String?
    }

    struct Deploy: Codable, Sendable, Equatable, Identifiable {
        /// `deployed` = a prod stage succeeded; a green build alone is not a deploy.
        enum Status: String, LenientStringEnum { case deployed, failed, unknown }

        var at: Date
        var image: String
        var version: String
        var stage: String
        var status: Status

        var id: String { "\(image)@\(version)@\(stage)@\(at.timeIntervalSince1970)" }
    }

    var title: String
    var from: Date
    var to: Date
    var stepSeconds: Int
    /// When the alert fired, on an alert's board.
    var marker: Date?
    var panels: [Panel]
    /// Newest first.
    var deploys: [Deploy]
    var fetchedAt: Date
    /// Nothing could be fetched (Grafana MCP down…); `panels` is then empty.
    var error: String?
}

// MARK: - Log sweep

/// The last sweep of prod's logs (`GET /logs`): error lines over the last day and risky
/// warnings over the last 2 hours, grouped into patterns, most telling first.
struct LogSweep: Codable, Sendable, Equatable {
    struct Pattern: Codable, Sendable, Equatable, Identifiable {
        enum Level: String, LenientStringEnum { case error, warning, unknown }
        /// `new`: no line before the last 15 minutes. `surging`: at least 5× its usual rate.
        enum Behaviour: String, LenientStringEnum { case new, surging, steady, unknown }

        struct Verdict: Codable, Sendable, Equatable {
            var problem: Double
            var agent: Double
            var users: Double
            var at: Date
        }

        var key: String
        var level: Level
        var behaviour: Behaviour
        /// What the sweep asks Jev about: a new or surging error, or any risky warning.
        var suspicious: Bool
        /// Busiest first: "merkl-compute-*", "api".
        var sources: [String]
        /// Numbers collapsed to `<N>`.
        var message: String
        /// One real line.
        var example: String
        var versions: [String]
        /// Lines in the last 15 minutes, and per 15 minutes before.
        var recent: Double
        var usual: Double
        /// Nil when Jev wasn't asked (steady errors, or Jev was down).
        var jev: Verdict?
        /// The finding it raised, when Jev called it a problem.
        var alertId: String?
        /// Grafana Explore on its lines, opened in the browser.
        var link: String

        var id: String { key }
    }

    /// Nil before the first sweep.
    var sweptAt: Date?
    /// Grafana Explore on prod's error lines over the last 3 hours.
    var link: String
    /// Why no sweep runs (watching off, Grafana MCP down), or a query that failed.
    var error: String?
    var patterns: [Pattern]
}

struct Status: Codable, Sendable, Equatable {
    enum Slack: String, LenientStringEnum { case ok, error, missing_token, unknown }
    enum JevHealth: String, LenientStringEnum { case ok, error, missing_key, unknown }
    enum GrafanaMcp: String, LenientStringEnum { case up, down, unknown }
    /// `blocked` = the GHE IP allow list refuses this network; sessions stay queued.
    enum GitHub: String, LenientStringEnum { case ok, blocked, unknown }

    var paused: Bool
    var dryRun: Bool
    var slack: Slack
    var jev: JevHealth
    var grafanaMcp: GrafanaMcp
    var github: GitHub
    var lastPollAt: Date?
    var error: String?
}

// MARK: - Alerts

struct AlertView: Codable, Sendable, Equatable, Identifiable {
    /// `inbox` = a mention, group mention or DM anywhere in Slack. `watch` = Bridgetown saw a prod
    /// signal rise in Grafana on its own; `permalink` is then the Grafana dashboard, not a Slack message.
    enum Source: String, LenientStringEnum { case releases, uptime, engine, inbox, generic, watch, unknown }
    enum Feedback: String, LenientStringEnum { case good, bad, unknown }

    var id: String
    var channelId: String
    var channelName: String
    var ts: String
    var permalink: String?
    var title: String
    var summary: String
    var source: Source
    var receivedAt: Date
    var triage: Triage
    var sessionId: String?
    var feedback: Feedback?
    /// What happened to it, computed by the daemon. Render this; never infer it from
    /// the triage decision or history text.
    var outcome: AlertOutcome
}

extension AlertView {
    /// What opening `permalink` shows: a prod finding's is its Grafana dashboard.
    var permalinkLabel: String { source == .watch ? "Open in Grafana" : "Open in Slack" }
}

struct AlertOutcome: Codable, Sendable, Equatable {
    /// waiting = an open card is in "Needs you" · dismissed = the user dismissed its card
    /// and no agent ran · opened = the user opened it from an escalation · withdrawn = a
    /// Bridgetown finding whose signal went back to normal before anyone acted · teammate = someone
    /// else's Bridgetown claimed it in Slack, or they reacted 👀 ("Alice's agent is on it") ·
    /// session = an agent session owns it; headline and tone are the session's own.
    enum Kind: String, LenientStringEnum {
        case pending, filtered, ignored, suggested, escalated, waiting, dismissed, opened, withdrawn, teammate, session, unknown
    }

    var kind: Kind
    /// "Filtered by a rule", "Waiting on you", "Resolved · deployed admin-v0.6.1".
    var headline: String
    /// One longer line for the detail view; nil when the headline says it all.
    var sentence: String?
    var tone: Tone
}

struct Triage: Codable, Sendable, Equatable {
    /// `escalate` = Jev says this needs the user personally.
    enum Decision: String, LenientStringEnum { case pending, filtered, ignore, suggest, auto, escalate, unknown }

    var decision: Decision
    var reason: String
    var jev: Jev?
}

struct Jev: Codable, Sendable, Equatable {
    enum Depth: String, LenientStringEnum { case quick, standard, deep, unknown }

    var actionable: Double
    var agentResolvable: Double
    var humanOnIt: Double
    var kind: String
    var kindConfidence: Double
    var depth: Depth
    var urgency: Double
}

/// Colour of a status dot and headline. `success` only for verified outcomes.
enum Tone: String, LenientStringEnum { case live, waiting, success, neutral, failure, unknown }

// MARK: - Alert detail

/// `GET /alerts/:id`: the full message, its history, its session and open actions.
struct AlertDetail: Codable, Sendable, Equatable {
    struct Event: Codable, Sendable, Equatable {
        var at: Date
        var text: String
    }

    var alert: AlertView
    /// The Slack message as mrkdwn, up to 4000 chars.
    var raw: String
    /// Oldest first.
    var events: [Event]
    var session: Session?
    /// Still-open cards for this alert.
    var actions: [Action]
}

// MARK: - Sessions

struct Session: Codable, Sendable, Equatable, Identifiable {
    enum State: String, LenientStringEnum {
        case queued, preparing, running, waiting, critiquing, ci, awaiting_merge, awaiting_release, deploying
        /// `resolved` = a verified outcome. `closed` = the user closed it without a fix.
        case resolved, closed, failed, stopped
        case unknown
    }

    enum Outcome: String, LenientStringEnum { case fix_pr, recommendation, no_action, needs_human, unknown }

    var id: String
    var alertId: String
    var title: String
    var channelName: String
    var status: State
    /// Always six, in order, computed by the daemon from evidence.
    var steps: [Step]
    /// Status line, e.g. "Running", "Closed · root cause not found".
    var headline: String
    var tone: Tone
    /// The review row, rendered as is: who reviews the agent's fixes, and where it stands.
    /// Optional so an older daemon, which sends neither, still decodes; the row is left out.
    var reviewerName: String?
    var critiqueLine: String?
    /// For finished sessions: the honest one-line outcome.
    var resolution: String?
    var rootCauseFound: Bool?
    var activity: String
    var diagnosis: String?
    var outcome: Outcome?
    var prUrl: String?
    var branch: String?
    var worktree: String?
    var claudeSessionId: String?
    var model: String
    var ciRounds: Int
    var costUsd: Double
    var slackThreadUrl: String?
    /// `POST /sessions/:id/message` is allowed: live, or finished and handed back with
    /// its worktree intact.
    var acceptsMessages: Bool
    /// `revv://pr?host=…&repo=…&number=…`, opens the PR walkthrough in Revv.
    var revvUrl: String?
    /// e.g. "product-approvals", once a review was requested there.
    var reviewChannel: String?
    /// Slack permalink of that review request.
    var reviewUrl: String?
    var startedAt: Date
    var updatedAt: Date
}

struct Step: Codable, Sendable, Equatable {
    enum Key: String, LenientStringEnum { case diagnose, fix, pr, critique, ci, deploy, unknown }

    /// done = evidence it happened · current = in progress · pending = not reached ·
    /// failed = where it stopped or broke · skipped = not applicable.
    enum State: String, LenientStringEnum { case done, current, pending, failed, skipped, unknown }

    var key: Key
    /// "Diagnose", "Fix", "PR", "Review", "CI", "Deploy", or the truth ("Root cause?", "No PR", "No review").
    var label: String
    var state: State
}

// MARK: - Actions

struct Action: Codable, Sendable, Equatable, Identifiable {
    /// `review`: the agent finished without a fix (or failed); primary is Retry or Close session.
    /// `reply`: `detail` is an agent-drafted reply to a teammate; resolve with the edited text.
    /// `escalate`: needs the user personally; the primary button opens `url`, then resolves.
    enum Kind: String, LenientStringEnum {
        case investigate, merge, release, rerun, answer, grafana, review, reply, escalate, unknown
    }

    var id: String
    var kind: Kind
    var title: String
    var detail: String
    var primaryLabel: String
    var options: [String]
    var sessionId: String?
    var alertId: String?
    /// Opened on the primary button before resolving (Slack permalink or revv:// link).
    var url: String?
    /// A resolve is running (merging, tagging a release…): show progress, not the button.
    var inFlight: Bool
    /// Dismissing records the session as closed, not fixed. The app confirms and says so.
    var dismissCloses: Bool
    var createdAt: Date
}

// MARK: - Settings

struct Settings: Codable, Sendable, Equatable {
    struct Channel: Codable, Sendable, Equatable, Identifiable {
        var id: String
        var name: String
        var enabled: Bool
    }

    struct Thresholds: Codable, Sendable, Equatable {
        var autoActionable: Double
        var autoResolvable: Double
        var autoHumanOnItMax: Double
        var suggestActionable: Double
        var suggestResolvable: Double
        /// A reviewer finding goes back to the agent only above these, and below `findingRebutted`.
        var findingReal: Double
        var findingBlocking: Double
        var findingRebutted: Double
    }

    struct QuietHours: Codable, Sendable, Equatable {
        var enabled: Bool
        var start: String  // "22:00"
        var end: String    // "08:00"
    }

    /// The top-level fields, which are also the granularity of `POST /settings`
    /// (`Partial<Settings>` is shallow: a nested object is always sent whole).
    enum CodingKeys: String, CodingKey, CaseIterable, Sendable {
        case channels, thresholds, autoStart, inbox, maxConcurrent, dryRun, adversarialReview, watchProd, pollSeconds
        case monorepoPath, deploymentRepoPath, quietHours
    }

    var channels: [Channel]
    var thresholds: Thresholds
    var autoStart: Bool
    /// Watch mentions, group mentions and DMs across all of Slack.
    var inbox: Bool
    var maxConcurrent: Int
    var dryRun: Bool
    /// Another vendor's model reviews each pushed fix before the PR leaves draft.
    var adversarialReview: Bool
    /// Watch prod signals in Grafana and suggest an investigation when one rises before any alert.
    var watchProd: Bool
    var pollSeconds: Int
    var monorepoPath: String
    var deploymentRepoPath: String
    var quietHours: QuietHours
}

extension Settings {
    /// Copies one top-level field from `other`.
    mutating func take(_ key: CodingKeys, from other: Settings) {
        switch key {
        case .channels: channels = other.channels
        case .thresholds: thresholds = other.thresholds
        case .autoStart: autoStart = other.autoStart
        case .inbox: inbox = other.inbox
        case .maxConcurrent: maxConcurrent = other.maxConcurrent
        case .dryRun: dryRun = other.dryRun
        case .adversarialReview: adversarialReview = other.adversarialReview
        case .watchProd: watchProd = other.watchProd
        case .pollSeconds: pollSeconds = other.pollSeconds
        case .monorepoPath: monorepoPath = other.monorepoPath
        case .deploymentRepoPath: deploymentRepoPath = other.deploymentRepoPath
        case .quietHours: quietHours = other.quietHours
        }
    }

    /// The top-level fields that differ between `self` and `other`.
    func changedKeys(to other: Settings) -> Set<CodingKeys> {
        Set(CodingKeys.allCases.filter { key in
            var probe = self
            probe.take(key, from: other)
            return probe != self
        })
    }

    /// `self` with `keys` taken from `overlay`.
    func overlaid(_ keys: some Sequence<CodingKeys>, from overlay: Settings) -> Settings {
        var out = self
        for key in keys { out.take(key, from: overlay) }
        return out
    }

    /// The `Partial<Settings>` body for `POST /settings`: only `keys`.
    func patchBody(_ keys: Set<CodingKeys>) throws -> Data {
        let full = try JSONSerialization.jsonObject(with: JSON.encoder().encode(self)) as? [String: Any] ?? [:]
        let wanted = Set(keys.map(\.rawValue))
        return try JSONSerialization.data(withJSONObject: full.filter { wanted.contains($0.key) }, options: [.sortedKeys])
    }

    /// One channel's toggle, addressable by key path (`\.[channel: id]`).
    subscript(channel id: String) -> Bool {
        get { channels.first { $0.id == id }?.enabled ?? false }
        set {
            guard let i = channels.firstIndex(where: { $0.id == id }) else { return }
            channels[i].enabled = newValue
        }
    }
}

// MARK: - Transcript

struct TranscriptEntry: Codable, Sendable, Equatable {
    enum Kind: String, LenientStringEnum { case text, tool, result, status, error, unknown }

    var at: Date
    var kind: Kind
    var text: String
}

struct APIErrorBody: Codable, Sendable {
    var error: String
}

// MARK: - Derived helpers

extension Session {
    var isActive: Bool {
        switch status {
        case .resolved, .closed, .failed, .stopped: false
        default: true
        }
    }
}

extension Snapshot {
    /// "Needs you" order: escalations first, otherwise the daemon's newest-first order.
    var sortedActions: [Action] {
        actions.filter { $0.kind == .escalate } + actions.filter { $0.kind != .escalate }
    }

    var activeSessions: [Session] { sessions.filter(\.isActive) }

    func session(id: String?) -> Session? {
        guard let id else { return nil }
        return sessions.first { $0.id == id }
    }

    func alert(id: String?) -> AlertView? {
        guard let id else { return nil }
        return alerts.first { $0.id == id }
    }

    func action(id: String) -> Action? {
        actions.first { $0.id == id }
    }
}

// MARK: - JSON

enum JSON {
    static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let s = try c.decode(String.self)
            if let date = ISO8601.parse(s) { return date }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Bad ISO-8601 date: \(s)")
        }
        return d
    }

    static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }
}

enum ISO8601 {
    static func parse(_ s: String) -> Date? {
        if let d = try? Date(s, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
        return try? Date(s, strategy: Date.ISO8601FormatStyle())
    }
}
