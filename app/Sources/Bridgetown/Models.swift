import Foundation

// Codable mirrors of the daemon's wire types (daemon/src/api/wire.ts), field for field.
// Every nullable field is always present on the wire, so optionals here decode `null` and
// are never missing. The test fixtures are the daemon's own output
// (daemon/test/api/contract.test.ts), so a model that drifts from it fails `make test-app`.
//
// String enums decode leniently: an unrecognised value maps to `.unknown` instead of
// failing the whole Snapshot, so a newer daemon can't blank the app.
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
    var metrics: Telemetry
    var settings: Settings
}

// MARK: - Telemetry

/// Sessions started in the last 24 hours, counted by the daemon over its whole store.
struct Telemetry: Codable, Sendable, Equatable {
    struct Sessions: Codable, Sendable, Equatable {
        var started: Int
        /// With a verified outcome.
        var resolved: Int
    }

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
            /// Oldest first.
            var points: [Point]
        }

        /// `[unix seconds, value]` on the wire.
        struct Point: Codable, Sendable, Equatable {
            var t: Double
            var v: Double

            init(t: Double, v: Double) {
                self.t = t
                self.v = v
            }

            init(from decoder: Decoder) throws {
                var pair = try decoder.unkeyedContainer()
                guard pair.count == 2 else {
                    throw DecodingError.dataCorruptedError(in: pair, debugDescription: "A point is [unix seconds, value]")
                }
                t = try pair.decode(Double.self)
                v = try pair.decode(Double.self)
            }

            func encode(to encoder: Encoder) throws {
                var pair = encoder.unkeyedContainer()
                try pair.encode(t)
                try pair.encode(v)
            }
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
        /// The prod watcher's judgement, the only one there is: its usual level per step of
        /// this board, and a step above `spikeAbove` is one its rule calls a spike. Nil for a
        /// panel no rule watches, or before the watcher has measured it.
        var usual: Double?
        var spikeAbove: Double?
        /// On a board that ends now: how many times its usual level the signal is, when the
        /// watcher finds it unusual.
        var spike: Double?
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

    var id: String
    /// Where it came from, as written: "#alert-releases", "DM", "group DM", "Grafana".
    var channelLabel: String
    var permalink: String?
    var title: String
    var summary: String
    var source: Source
    var receivedAt: Date
    var triage: Triage
    var sessionId: String?
    /// What happened to it, computed by the daemon. Render this; never infer it from
    /// the triage decision or history text.
    var outcome: AlertOutcome
}

struct AlertOutcome: Codable, Sendable, Equatable {
    /// waiting = an open card is in "Needs you" · dismissed = the user dismissed its card
    /// and no agent ran · opened = the user opened it from an escalation · withdrawn = a
    /// Bridgetown finding whose signal went back to normal before anyone acted · teammate = someone
    /// else's Bridgetown claimed it in Slack, or they reacted 👀 ("Alice's agent is on it") ·
    /// session = an agent session owns it; headline and tone are the session's own.
    enum Kind: String, LenientStringEnum {
        case filtered, ignored, suggested, escalated, waiting, dismissed, opened, withdrawn, teammate, session, unknown
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
    enum Decision: String, LenientStringEnum { case filtered, ignore, suggest, auto, escalate, unknown }

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
    /// The Slack message as Markdown (the daemon translates its mrkdwn), up to 4000 chars.
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

    /// Who has its next move. agent: preparing or working · critic: the adversarial review
    /// runs · you: a question, a merge, a release, a review request that didn't go out ·
    /// reviewers: in review in an approvals channel · ci · deploy · queue: waiting for a slot.
    enum Holder: String, LenientStringEnum { case agent, critic, you, reviewers, ci, deploy, queue, unknown }

    var id: String
    var alertId: String
    var title: String
    /// Where its alert came from, as written: "#alert-releases", "DM", "Grafana".
    var channelLabel: String
    var status: State
    /// Always six, in order, computed by the daemon from evidence.
    var steps: [Step]
    /// Status line, e.g. "Agent working"; once it has ended, how ("Closed · root cause not found").
    var headline: String
    var tone: Tone
    /// Nil once it has ended. The tone can't say: "In review" is live, yet nobody works on it.
    var holder: Holder?
    /// The review row, rendered as is: who reviews the agent's fixes, and where it stands.
    var reviewerName: String
    var critiqueLine: String
    /// The CI row: "Passed · 1 round", "Running", "Not needed", "Not run".
    var ciLine: String
    var rootCauseFound: Bool?
    var activity: String
    var diagnosis: String?
    var outcome: Outcome?
    var prUrl: String?
    var branch: String?
    var worktree: String?
    var provider: AgentProvider
    var agentSessionId: String?
    var agentConfigDir: String?
    var model: String
    var ciRounds: Int
    var costUsd: Double?
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
    /// What there is to show for it, under its name: "Cause found", "#3340", the review's
    /// line, CI's. Nil before it is reached.
    var detail: String?
}

// MARK: - Actions

struct Action: Codable, Sendable, Equatable, Identifiable {
    /// `review`: the agent finished without a fix (or failed); primary is Retry or Close session.
    /// `reply`: `detail` is an agent-drafted reply to a teammate; resolve with the edited text.
    /// `escalate`: needs the user personally; the primary button opens `url`, then resolves.
    enum Kind: String, LenientStringEnum {
        case investigate, merge, release, rerun, answer, review, reply, escalate, unknown
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

    /// The top-level fields, which are also the granularity the app sends `POST /settings`
    /// in: a changed nested object is sent whole, though the daemon would merge
    /// `thresholds` and `quietHours` key by key.
    enum CodingKeys: String, CodingKey, CaseIterable, Sendable {
        case channels, thresholds, autoStart, inbox, maxConcurrent, dryRun, adversarialReview, watchProd, pollSeconds
        case monorepoPath, deploymentRepoPath, quietHours, models
    }

    var channels: [Channel]
    var thresholds: Thresholds
    var autoStart: Bool
    /// Watch mentions, group mentions and DMs across all of Slack.
    var inbox: Bool
    var maxConcurrent: Int
    var dryRun: Bool
    /// The selected reviewer checks each pushed fix before the PR leaves draft.
    var adversarialReview: Bool
    /// Watch prod signals in Grafana and investigate one that rises before any alert (one Jev
    /// doubts is only suggested).
    var watchProd: Bool
    /// Whole seconds, at least 10.
    var pollSeconds: Int
    var monorepoPath: String
    var deploymentRepoPath: String
    var quietHours: QuietHours
    var models: ModelSettings = ModelSettings()
}

extension Settings {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channels = try c.decode([Channel].self, forKey: .channels)
        thresholds = try c.decode(Thresholds.self, forKey: .thresholds)
        autoStart = try c.decode(Bool.self, forKey: .autoStart)
        inbox = try c.decode(Bool.self, forKey: .inbox)
        maxConcurrent = try c.decode(Int.self, forKey: .maxConcurrent)
        dryRun = try c.decode(Bool.self, forKey: .dryRun)
        adversarialReview = try c.decode(Bool.self, forKey: .adversarialReview)
        watchProd = try c.decode(Bool.self, forKey: .watchProd)
        pollSeconds = try c.decode(Int.self, forKey: .pollSeconds)
        monorepoPath = try c.decode(String.self, forKey: .monorepoPath)
        deploymentRepoPath = try c.decode(String.self, forKey: .deploymentRepoPath)
        quietHours = try c.decode(QuietHours.self, forKey: .quietHours)
        models = try c.decodeIfPresent(ModelSettings.self, forKey: .models) ?? ModelSettings()
    }
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
        case .models: models = other.models
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
            // With milliseconds (the daemon's `toISOString`) or without.
            let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
            if let date = (try? Date(s, strategy: fractional)) ?? (try? Date(s, strategy: .iso8601)) { return date }
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
