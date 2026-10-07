import type { Triage } from "../domain/alert.ts"
import type { ActionKind } from "../domain/action.ts"
import type { Outcome, SessionStatus, TranscriptEntry } from "../domain/session.ts"
import type { Settings } from "../domain/settings.ts"
import type { Unit } from "../grafana/boards.ts"
import type { Reachability } from "../ship/github.ts"
import type { Behaviour } from "../watch/logs.ts"

/**
 * The contract with the app: every shape the API sends, defined once. The view builders in views.ts are typed by
 * these, so a wire change has to happen here, where the app's Models.swift mirrors it. daemon/test/api/contract.test.ts
 * writes real output of the builders to the app's test fixtures (app/Tests/BridgetownTests/Fixtures), which the
 * app's tests decode: a change that is not made on both sides fails one of them.
 *
 * Every nullable field is always present, `null` when it has no value. Timestamps are ISO-8601 strings. What the
 * daemon computes (outcomes, steps, headlines, who has the next move, labels) is sent ready to render: the app never
 * infers it from other fields.
 */

/** `GET /state`, and the data of every `event: snapshot` on `GET /events`. */
export interface Snapshot {
  readonly status: Status
  /** "Needs you", newest first. */
  readonly actions: ReadonlyArray<ActionView>
  /** Active sessions first, then the 20 most recent finished ones. */
  readonly sessions: ReadonlyArray<SessionView>
  /** The last 30 alerts, newest first. */
  readonly alerts: ReadonlyArray<AlertView>
  readonly metrics: Metrics
  readonly settings: Settings
}

export interface Status {
  readonly paused: boolean
  /** The settings toggle or the daemon's `--dry-run` flag: nothing is posted to Slack. */
  readonly dryRun: boolean
  readonly slack: "ok" | "error" | "missing_token"
  readonly jev: "ok" | "error" | "missing_key"
  readonly grafanaMcp: "up" | "down"
  /** GitHub Enterprise. `blocked`: its IP allow list refuses this network, and sessions stay queued; not repeated in `error`. */
  readonly github: Reachability
  readonly lastPollAt: string | null
  /** The latest problem still standing, one line. */
  readonly error: string | null
}

/** Sessions started in the last 24 hours, counted over the whole store (not just the 30 alerts in the snapshot). */
export interface Metrics {
  readonly sessions: {
    readonly started: number
    /** With a verified outcome. */
    readonly resolved: number
  }
}

/** Colour of a status dot and headline. `success` only for an outcome the daemon verified. */
export type Tone = "live" | "waiting" | "success" | "neutral" | "failure"

// MARK: Alerts

export interface AlertView {
  /** `<channelId>:<ts>` of its Slack message, or `watch:<signal>:<since>` for a prod finding. */
  readonly id: string
  /** Where it came from, as written: "#alert-releases", "DM" or "group DM" for an inbox message outside a channel, "Grafana" for a prod finding. */
  readonly channelLabel: string
  /** The Slack message, or for a prod finding its Grafana dashboard. */
  readonly permalink: string | null
  /** "merkl-admin v0.6.0 · Build failed". */
  readonly title: string
  /** One line; a prod finding's is a few sentences (the rise, deploys around it). */
  readonly summary: string
  /**
   * `inbox`: a mention, group mention or DM anywhere in Slack, including a person's message in an alert channel.
   * `watch`: a prod signal Bridgetown saw rise in Grafana itself, with no Slack thread.
   */
  readonly source: "releases" | "uptime" | "engine" | "inbox" | "generic" | "watch"
  readonly receivedAt: string
  readonly triage: Triage
  readonly sessionId: string | null
  /** What happened to it. Render this; never infer it from the triage or the history. */
  readonly outcome: AlertOutcome
}

/**
 * waiting: an open card for it is in "Needs you" · dismissed: you dismissed its card and no agent ran · opened: you
 * opened it from an escalation · withdrawn: a finding whose signal went back to normal before anyone acted · teammate:
 * no session of yours, and a teammate is on it per Slack ("Julien's agent is on it") · session: an agent session owns
 * it, and the headline and tone are the session's own.
 */
export type OutcomeKind = "filtered" | "ignored" | "suggested" | "escalated" | "waiting" | "dismissed" | "opened" | "withdrawn" | "teammate" | "session"

export interface AlertOutcome {
  readonly kind: OutcomeKind
  /** "Filtered by a rule", "Waiting on you", "Resolved · deployed admin-v0.6.1". */
  readonly headline: string
  /** One longer line for the detail view ("No agent ran. Jev ignored it."); `null` when the headline says it all. */
  readonly sentence: string | null
  readonly tone: Tone
}

/** `GET /alerts/:id`. */
export interface AlertDetail {
  readonly alert: AlertView
  /** The Slack message as Markdown (links, mentions, emphasis and emoji translated from mrkdwn), up to 4000 chars. */
  readonly raw: string
  /**
   * Oldest first: "Ignored by Jev: …", "Agent session started (…)", "Agent session ended · <session headline>" once its
   * session finishes, "Agent session resumed". Render them as they are.
   */
  readonly events: ReadonlyArray<{ readonly at: string; readonly text: string }>
  readonly session: SessionView | null
  /** Its cards still open. */
  readonly actions: ReadonlyArray<ActionView>
}

// MARK: Sessions

export interface SessionView {
  readonly id: string
  readonly alertId: string
  readonly title: string
  /** Where its alert came from, as written: "#alert-releases", "DM", "Grafana". */
  readonly channelLabel: string
  /**
   * resolved: a verified outcome (deployed, merged with nothing to ship, a confirmed no-op) · closed: closed without a
   * fix, never a success · critiquing: another vendor's model reviews the pushed fix, the PR a draft until it passes.
   */
  readonly status: SessionStatus
  /** Always six, in order, from evidence. */
  readonly steps: ReadonlyArray<Step>
  /** The status line: "Agent working", "Waiting on you", and once it has ended, how: "Resolved · deployed admin-v0.6.1", "Closed · root cause not found". */
  readonly headline: string
  readonly tone: Tone
  /** Who has its next move; `null` once it has ended. The tone can't say: "In review" is live, yet nobody works on it. */
  readonly holder: Holder | null
  /** Who reviews the agent's fixes: "Codex". */
  readonly reviewerName: string
  /** Where that review stands: "Reviewing · round 2", "Passed · 1 round of fixes · 2 dropped by Jev", "Not run". */
  readonly critiqueLine: string
  /** Where CI stands: "Passed · 1 round", "Running", "Failed · 2 rounds", "Not needed", "Not run". */
  readonly ciLine: string
  readonly rootCauseFound: boolean | null
  /** The latest thing it did, one line ("Reading failed job logs…"). */
  readonly activity: string
  readonly diagnosis: string | null
  readonly outcome: Outcome | null
  readonly prUrl: string | null
  readonly branch: string | null
  readonly worktree: string | null
  readonly claudeSessionId: string | null
  readonly model: string
  readonly ciRounds: number
  readonly costUsd: number
  readonly slackThreadUrl: string | null
  /** `POST /sessions/:id/message` is allowed: live, or finished and handed back with its worktree intact. */
  readonly acceptsMessages: boolean
  /** `revv://pr?host=…&repo=…&number=…`: the PR's walkthrough in Revv. */
  readonly revvUrl: string | null
  /** "product-approvals", once a review was requested there. */
  readonly reviewChannel: string | null
  /** That review request's permalink. */
  readonly reviewUrl: string | null
  readonly startedAt: string
  readonly updatedAt: string
}

/**
 * agent: preparing or working · critic: the adversarial review is running · you: waiting on you (a question, a merge,
 * a release, a review request that didn't go out) · reviewers: in review in an approvals channel · ci: CI running ·
 * deploy: deploying · queue: waiting for a free agent slot.
 */
export type Holder = "agent" | "critic" | "you" | "reviewers" | "ci" | "deploy" | "queue"

export type StepKey = "diagnose" | "fix" | "pr" | "critique" | "ci" | "deploy"

/**
 * done: evidence it happened · current: in progress · pending: not reached · failed: where it stopped or broke ·
 * skipped: not applicable (no release needed, no review).
 */
export type StepState = "done" | "current" | "pending" | "failed" | "skipped"

export interface Step {
  readonly key: StepKey
  /** "Diagnose", "Fix", "PR", "Review", "CI", "Deploy", or the truth: "Root cause?", "No PR", "No review", "Deployed". */
  readonly label: string
  readonly state: StepState
  /** What there is to show for it, under its name: "Cause found", "#3340", the review's line, CI's. `null` before it is reached. */
  readonly detail: string | null
}

// MARK: Actions

export interface ActionView {
  readonly id: string
  /**
   * review: the agent finished without a fix (or failed); the primary is "Retry" or "Close session" · reply: `detail`
   * is a reply the agent drafted, resolved with the edited text · escalate: needs you personally; the primary opens `url`.
   */
  readonly kind: ActionKind
  readonly title: string
  readonly detail: string
  /** "Investigate", "Merge", "Cut admin-v0.6.1", "Re-run", "Reply", "Retry", "Send", "Open in Slack", "Open in Revv". */
  readonly primaryLabel: string
  /** Quick replies for an `answer`; may be empty. */
  readonly options: ReadonlyArray<string>
  readonly sessionId: string | null
  readonly alertId: string | null
  /** Opened on the primary button before resolving: https:, slack: and revv: URLs only. */
  readonly url: string | null
  /** A resolve is running (merging, cutting a release): show progress, not the button. */
  readonly inFlight: boolean
  /** Dismissing records its session as closed, not fixed: the app confirms and says so. */
  readonly dismissCloses: boolean
  readonly createdAt: string
}

// MARK: Grafana

/** `GET /boards/:view` and `GET /alerts/:id/board`: a small dashboard, read through the local grafana MCP. */
export interface Board {
  /** "Incidents", "API · /v4/opportunities", "merkl-api", "Chain 42161". */
  readonly title: string
  readonly from: string
  readonly to: string
  /** One point per step; a count panel counts per step. */
  readonly stepSeconds: number
  /** When the alert fired, on an alert's board. */
  readonly marker: string | null
  readonly panels: ReadonlyArray<Panel>
  /** Newest first: the window's (72 hours back for a release's image). */
  readonly deploys: ReadonlyArray<Deploy>
  /** A board over a minute old comes back at once while a fresh one is fetched. */
  readonly fetchedAt: string
  /** Nothing could be fetched (Grafana MCP down); `panels` is then empty. */
  readonly error: string | null
}

export interface Panel {
  readonly id: string
  readonly title: string
  readonly unit: Unit
  /** Each point `[unix seconds, value]`, oldest first. */
  readonly series: ReadonlyArray<{ readonly label: string; readonly points: ReadonlyArray<readonly [number, number]> }>
  /** The sum of each series' last point (every pod across versions), or `null` with no data. */
  readonly latest: number | null
  /** The Grafana dashboard over the board's window, for the browser. */
  readonly link: string
  /** This panel's query failed; the others still show. */
  readonly error: string | null
  /**
   * The prod watcher's judgement of the signal, the only one there is: its usual level per step of this board, and a
   * step above `spikeAbove` is one its rule calls a spike. `null` for a panel no rule watches, or before the watcher
   * has measured it.
   */
  readonly usual: number | null
  readonly spikeAbove: number | null
  /** On a board that ends now: how many times its usual level the signal is, when the watcher finds it unusual; else `null`. */
  readonly spike: number | null
}

/** A prod deploy, or a deploy that failed at some stage. */
export interface Deploy {
  readonly at: string
  /** "merkl-api". */
  readonly image: string
  /** "v1.35.11". */
  readonly version: string
  /** "engine", "front-production", or where it failed. */
  readonly stage: string
  /** deployed: a prod stage succeeded; a green build alone is not a deploy. */
  readonly status: "deployed" | "failed"
}

/** `GET /logs`: prod's error lines over the last day and risky warnings over the last 2 hours, grouped into patterns. */
export interface LogSweep {
  /** The last sweep; `null` before the first. */
  readonly sweptAt: string | null
  /** Grafana Explore on prod's error lines over the last 3 hours. */
  readonly link: string
  /** Why no sweep runs (watching off, Grafana MCP down), else a query of the last sweep that failed. */
  readonly error: string | null
  /** Suspicious first (new, then surging, then risky warnings), then steady errors; busiest first within each. */
  readonly patterns: ReadonlyArray<LogPatternView>
}

export interface LogPatternView {
  readonly key: string
  readonly level: "error" | "warning"
  /** new: no line before the last 15 minutes · surging: at least 5× its usual rate. */
  readonly behaviour: Behaviour
  /** What the sweep asks Jev about: a new or surging error, or any risky warning. Steady errors are the day's noise. */
  readonly suspicious: boolean
  /** The jobs or services that logged it, busiest first: "merkl-compute-*", "api". */
  readonly sources: ReadonlyArray<string>
  /** Numbers collapsed to `<N>`. */
  readonly message: string
  /** One real line. */
  readonly example: string
  /** Image tags that logged it, up to 3. */
  readonly versions: ReadonlyArray<string>
  /** Lines in the last 15 minutes, and per 15 minutes over the rest of the window. */
  readonly recent: number
  readonly usual: number
  /** Jev's verdict (0..1 each), asked at most once a day; `null` when not asked. */
  readonly jev: { readonly problem: number; readonly agent: number; readonly users: number; readonly at: string } | null
  /** The finding it raised, when Jev called it a problem. */
  readonly alertId: string | null
  /** Grafana Explore on its lines. */
  readonly link: string
}

// MARK: The rest

/** `GET /sessions/:id/transcript`: the last 200 entries, oldest first. */
export type { TranscriptEntry }

/** `GET /health`, without a token. */
export interface Health {
  readonly ok: true
  readonly version: string
}

/** GET /memory and POST /memory/run. */
export interface MemoryStatus {
  readonly enabled: boolean
  readonly path: string
  readonly state: "disabled" | "idle" | "queued" | "learning" | "dreaming" | "error"
  readonly pending: number
  readonly lastLearnedAt: string | null
  readonly lastDreamedAt: string | null
  readonly error: string | null
}
