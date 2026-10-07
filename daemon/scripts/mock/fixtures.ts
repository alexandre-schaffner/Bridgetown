import type { Action } from "../../src/domain/action.ts"
import { type Alert, type AlertFields, type AlertSource, type Disposition, type Triage, triageEvent, WATCH_CHANNEL } from "../../src/domain/alert.ts"
import { sessionEndEvent, sessionStartEvent } from "../../src/domain/progress.ts"
import { isFinished, NO_MILESTONES, type Session, type TranscriptEntry } from "../../src/domain/session.ts"
import { type Channel, DEFAULT_CHANNELS, DEFAULT_SETTINGS, type Settings } from "../../src/domain/settings.ts"
import { truncate } from "../../src/lib/text.ts"
import { newSession } from "../../src/sessions/new-session.ts"
import { releaseDetail } from "../../src/ship/cards.ts"
import type { MockPr } from "./fakes.ts"

/** The log finding's fingerprint: the Goldsky pattern in the mock's log sweep (grafana.ts) points at it. */
export const LOG_FINDING_FINGERPRINT = "watch:log:1234567890"

/**
 * The world the mock starts in, typed by the daemon's own model. Every session
 * is a state the real daemon reaches (its stepper and headline come from
 * `progressOf`), and every alert's outcome is computed by `alertOutcome`.
 * Sessions marked live start for real: the runner prepares a worktree and runs
 * the scripted agent. Every time is relative to the world's `now`, so a frozen
 * clock (`MOCK_NOW`) gives the same ids and timestamps on every run.
 */

/** Minutes before the world's `now`, as ISO timestamps and as Slack `ts`. */
const clockAt = (now: number) => ({
  ago: (minutes: number) => new Date(now - minutes * 60_000).toISOString(),
  tsAgo: (minutes: number) => ((now - minutes * 60_000) / 1000).toFixed(6),
})
type Clock = ReturnType<typeof clockAt>

const slack = (channelId: string, ts: string) => `https://merkl.slack.com/archives/${channelId}/p${ts.replace(".", "")}`
export const pr = (n: number) => `https://nocturlab.ghe.com/Merkl/monorepo/pull/${n}`

const channel = (name: string): Channel => DEFAULT_CHANNELS.find((c) => c.name === name) ?? { id: `C${name.toUpperCase()}`, name, enabled: true }
const RELEASES = channel("alert-releases")
const UPTIME = channel("alert-uptime")
const ENGINE = channel("alert-engine")
const INFRA = channel("alert-infra")
const DEV = channel("alert-dev")
const ENG_API: Channel = { id: "C03ENGAPI01", name: "eng-api", enabled: true }
const DM_HUGO: Channel = { id: "D05HUGO0001", name: "DM", enabled: true }
const PRODUCT: Channel = { id: "C04PRODUCT1", name: "product", enabled: true }

const jev = (kind: NonNullable<Triage["jev"]>["kind"], actionable: number, agentResolvable: number, humanOnIt: number, depth: "quick" | "standard" | "deep", urgency: number) => ({
  actionable, agentResolvable, humanOnIt, kind, kindConfidence: 0.9, depth, urgency,
})

interface AlertSpec {
  readonly channel: Channel
  readonly minutesAgo: number
  readonly title: string
  readonly summary: string
  readonly raw?: string
  readonly source: AlertSource
  readonly fields?: AlertFields
  readonly triage: Triage
  readonly sessionId?: string
  /** History after the triage line (dismissals…). */
  readonly events?: ReadonlyArray<{ readonly minutesAgo: number; readonly text: string }>
  readonly disposition?: { readonly kind: Disposition["kind"]; readonly minutesAgo: number }
  readonly claimedBy?: Alert["claimedBy"]
}

const alert = ({ ago, tsAgo }: Clock, spec: AlertSpec): Alert => {
  const ts = tsAgo(spec.minutesAgo)
  return {
    id: `${spec.channel.id}:${ts}`,
    channelId: spec.channel.id,
    channelName: spec.channel.name,
    ts,
    permalink: slack(spec.channel.id, ts),
    title: spec.title,
    summary: spec.summary,
    raw: spec.raw ?? `*${spec.title}*\n${spec.summary}`,
    source: spec.source,
    fingerprint: `${spec.source}:${spec.channel.name}:${spec.title}`,
    fields: spec.fields ?? { _tag: "generic" },
    mentionsMe: spec.source === "inbox",
    receivedAt: ago(spec.minutesAgo),
    triage: spec.triage,
    sessionId: spec.sessionId ?? null,
    events: [
      { at: ago(spec.minutesAgo - 0.05), text: triageEvent(spec.triage) },
      ...(spec.events ?? []).map((e) => ({ at: ago(e.minutesAgo), text: e.text })),
    ],
    disposition: spec.disposition === undefined ? null : { kind: spec.disposition.kind, at: ago(spec.disposition.minutesAgo) },
    claimedBy: spec.claimedBy ?? [],
  }
}

const release = (image: string, version: string, tag: string, failed: string): AlertFields => ({
  _tag: "release", image, version, actor: "alex", runId: "291250187", runUrl: "https://nocturlab.ghe.com/Merkl/monorepo/actions/runs/291250187", tag,
  stages: [
    { name: "Approval", status: "success", detail: "Approved by hugo" },
    { name: failed, status: "failure", detail: `${failed} failed · 1 attempt failed` },
  ],
})

const inbox = (from: string, fromName: string, via: "mention" | "dm", prUrl: string | null = null): AlertFields => ({
  _tag: "inbox", from, fromName, channelKind: via === "dm" ? "dm" : "channel", via, threadTs: null, prUrl,
})

const auto = (reason: string, verdict: Triage["jev"]): Triage => ({ decision: "auto", reason, jev: verdict })

export const SESSION = {
  running: "s_mock_running",
  ask: "s_mock_ask",
  ci: "s_mock_ci",
  merge: "s_mock_merge",
  release: "s_mock_release",
  inFlight: "s_mock_inflight",
  deploying: "s_mock_deploying",
  resolved: "s_mock_resolved",
  closed: "s_mock_closed",
  failedCi: "s_mock_failed_ci",
  failedSetup: "s_mock_failed_setup",
  stopped: "s_mock_stopped",
  reply: "s_mock_reply",
  review: "s_mock_review",
  critique: "s_mock_critique",
} as const

/** Static worlds only: in the live mock the runner would start these at once. */
export const STILL_SESSION = {
  queued: "s_mock_queued",
  preparing: "s_mock_preparing",
} as const

/** The release whose `gh release create` is still running at startup: its card shows `inFlight`. */
export const IN_FLIGHT_TAG = "indexer-v0.9.3"

/** What the asking agent stops on (scripts.ts); a static world starts with its answer card up. */
export const ASK = {
  question: "The keeper's Arbitrum RPC is rate-limiting it. Switch the keeper to the fallback provider and re-submit the pending root?",
  options: ["Switch and re-submit", "Only re-submit", "Leave it to on-call"],
} as const

/** What the running agent is doing once it has found the cause (scripts.ts). */
export const RUNNING_NOTE = "Guarding computeApr against campaigns without a reward token"

/** A UUID-shaped id derived from `seed`, so Claude session ids are the same every run. */
const uuidFor = (seed: string) => {
  const hex = new Bun.CryptoHasher("sha256").update(seed).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export interface WorldOptions {
  /** The world's present, in epoch milliseconds: every time in it is relative to this. */
  readonly now: number
  readonly repoPath: string
  readonly worktrees: string
  /** `empty`: a fresh install that has received nothing yet, the only way to see the overview's empty state. */
  readonly world: "full" | "empty"
  /**
   * Nothing moves on its own: the running and asking agents are seeded mid-turn rather than
   * started, and a queued and a preparing session stand still, for screenshots that compare.
   */
  readonly static: boolean
}

export const buildFixtures = (options: WorldOptions) => {
  const clock = clockAt(options.now)
  const { ago, tsAgo } = clock
  const worktree = (branch: string | null) => (branch === null ? null : `${options.worktrees}/${branch}`)

  /** The real `newSession` for the alert, moved to `status` with the evidence that state implies. */
  const session = (a: Alert, status: Session["status"], minutes: { readonly started: number; readonly updated: number }, overrides: Partial<Session> = {}): Session => {
    const base = newSession(a, a.sessionId ?? "", options.repoPath)
    return {
      ...base,
      status,
      activity: "",
      worktree: worktree(base.branch),
      claudeSessionId: uuidFor(base.id),
      startedAt: ago(minutes.started),
      updatedAt: ago(minutes.updated),
      ...overrides,
    }
  }
  const shipped = (milestones: Partial<Session["milestones"]>) => ({ ...NO_MILESTONES, diagnosed: true, fixed: true, prOpened: true, critiqued: true, ...milestones })
  const reviewed = { channelName: "product-approvals", permalink: slack("C05APPROVALS", tsAgo(20)), handledReviewId: null, posted: true }

  const A = {
    running: alert(clock, { channel: DEV, minutesAgo: 9, title: "merkl-api · 5xx rate 3.1% on /v4/opportunities", summary: "Sentry: TypeError: Cannot read properties of undefined (reading 'apr')", source: "generic", sessionId: SESSION.running, triage: auto("Agent-resolvable runtime_error (actionable 88% · agent 81%)", jev("runtime_error", 0.88, 0.81, 0.07, "standard", 2.1)) }),
    ask: alert(clock, { channel: ENGINE, minutesAgo: 26, title: "Keeper missed 2 root updates on Arbitrum", summary: "merkl-keeper: last successful update 2h14m ago (threshold 1h)", source: "engine", fields: { _tag: "engine", subject: "merkl-keeper", error: "root update overdue on Arbitrum", txHash: null }, sessionId: SESSION.ask, triage: auto("Agent-resolvable onchain_or_keeper (actionable 86% · agent 77%)", jev("onchain_or_keeper", 0.86, 0.77, 0.2, "deep", 2.6)) }),
    ci: alert(clock, { channel: RELEASES, minutesAgo: 38, title: "merkl-studio v1.4.0 · Build failed", summary: "Approval ✓ · Build ✗ (1 attempt failed)", source: "releases", fields: release("merkl-studio", "v1.4.0", "studio-v1.4.0", "Build"), sessionId: SESSION.ci, triage: auto("Agent-resolvable build_failure (actionable 92% · agent 84%)", jev("build_failure", 0.92, 0.84, 0.11, "standard", 1.8)) }),
    merge: alert(clock, { channel: RELEASES, minutesAgo: 70, title: "merkl-app v2.15.0 · Build failed", summary: "Approval ✓ · Build ✗ (1 attempt failed)", source: "releases", fields: release("merkl-app", "v2.15.0", "app-v2.15.0", "Build"), sessionId: SESSION.merge, triage: auto("Agent-resolvable build_failure (actionable 93% · agent 86%)", jev("build_failure", 0.93, 0.86, 0.05, "standard", 1.7)) }),
    release: alert(clock, { channel: RELEASES, minutesAgo: 110, title: "merkl-dispute v0.4.2 · Build failed", summary: "Approval ✓ · Build ✗ (2 attempts failed)", source: "releases", fields: release("merkl-dispute", "v0.4.2", "dispute-v0.4.2", "Build"), sessionId: SESSION.release, triage: auto("Agent-resolvable build_failure (actionable 91% · agent 83%)", jev("build_failure", 0.91, 0.83, 0.09, "quick", 1.4)) }),
    inFlight: alert(clock, { channel: RELEASES, minutesAgo: 150, title: "merkl-indexer v0.9.2 · Build failed", summary: "Approval ✓ · Build ✗ (docker pull rate-limited)", source: "releases", fields: release("merkl-indexer", "v0.9.2", "indexer-v0.9.2", "Build"), sessionId: SESSION.inFlight, triage: auto("Agent-resolvable build_failure (actionable 83% · agent 79%)", jev("build_failure", 0.83, 0.79, 0.15, "quick", 1.2)) }),
    deploying: alert(clock, { channel: RELEASES, minutesAgo: 190, title: "merkl-api v1.35.10 · Production deploy failed", summary: "Approval ✓ · Build ✓ · Production ✗", source: "releases", fields: release("merkl-api", "v1.35.10", "api-v1.35.10", "Production"), sessionId: SESSION.deploying, triage: auto("Agent-resolvable deploy_failure (actionable 90% · agent 78%)", jev("deploy_failure", 0.9, 0.78, 0.1, "standard", 2.2)) }),
    resolved: alert(clock, { channel: RELEASES, minutesAgo: 300, title: "merkl-admin v0.6.0 · Build failed", summary: "Approval ✓ · Build ✗ (1 attempt failed)", source: "releases", fields: release("merkl-admin", "v0.6.0", "admin-v0.6.0", "Build"), sessionId: SESSION.resolved, triage: auto("Agent-resolvable build_failure (actionable 92% · agent 84%)", jev("build_failure", 0.92, 0.84, 0.11, "standard", 1.8)) }),
    closed: alert(clock, {
      channel: ENGINE, minutesAgo: 420, title: "TX Executor · 14 transactions stuck pending on Base", summary: "tx-executor: nonce gap at 48,211, oldest pending tx 41m", source: "engine", sessionId: SESSION.closed,
      fields: { _tag: "engine", subject: "tx-executor", error: "nonce gap at 48,211", txHash: "0x9e1b77fa" },
      raw: [":rotating_light: *TX Executor · 14 transactions stuck pending on Base*", "*Chain:* Base (8453)", "*Signer:* `0x7a3f…c21d` (executor-base-1)", "*Nonce gap:* 48,211 (mempool lowest 48,212)", "*Pending:* 14 transactions, oldest 41m", "<https://grafana.merkl.xyz/d/tx-executor?var-chain=base|Grafana dashboard> · <https://www.notion.so/merkl/runbook-tx-executor|Runbook>", "cc <!subteam^S04ONCALL|@engine-oncall>"].join("\n"),
      triage: auto("Agent-resolvable onchain_or_keeper (actionable 87% · agent 76%)", jev("onchain_or_keeper", 0.87, 0.76, 0.14, "deep", 2.3)),
    }),
    failedCi: alert(clock, { channel: RELEASES, minutesAgo: 600, title: "merkl-states-exporter v0.1.0 · Build failed", summary: "Approval ✓ · Build ✗ (3 attempts failed)", source: "releases", fields: release("merkl-states-exporter", "v0.1.0", "states-exporter-v0.1.0", "Build"), sessionId: SESSION.failedCi, triage: auto("Agent-resolvable build_failure (actionable 89% · agent 80%)", jev("build_failure", 0.89, 0.8, 0.12, "quick", 1.3)) }),
    failedSetup: alert(clock, { channel: ENGINE, minutesAgo: 140, title: "Dispute bot health check failing on Polygon", summary: "merkl-dispute: /health returned 503 for 10 minutes", source: "engine", fields: { _tag: "engine", subject: "merkl-dispute", error: "/health 503", txHash: null }, sessionId: SESSION.failedSetup, triage: auto("Agent-resolvable runtime_error (actionable 80% · agent 76%)", jev("runtime_error", 0.8, 0.76, 0.2, "standard", 1.7)) }),
    stopped: alert(clock, { channel: DEV, minutesAgo: 250, title: "merkl-api · p99 latency 2.3s on /v4/campaigns", summary: "Grafana: p99 above 2s for 15 minutes", source: "generic", sessionId: SESSION.stopped, triage: auto("Agent-resolvable runtime_error (actionable 82% · agent 77%)", jev("runtime_error", 0.82, 0.77, 0.18, "standard", 1.5)) }),
    reply: alert(clock, { channel: ENG_API, minutesAgo: 6, title: "Pierre · #eng-api: opportunities page 500s with an empty chainId?", summary: "\"@alex can you check why /opportunities 500s when chainId is empty?\"", raw: "<@U03ALEX> can you check why /opportunities 500s when chainId is empty?", source: "inbox", fields: inbox("U03PIERRE", "Pierre", "mention"), sessionId: SESSION.reply, triage: auto("Delegable investigation (needs you 84% · agent 79%)", jev("investigation", 0.84, 0.79, 0.12, "standard", 1.1)) }),
    review: alert(clock, { channel: ENGINE, minutesAgo: 24, title: "Engine · reward computation timed out for campaign 0x4f1c…a9e2", summary: "merkl-engine: computeRewards exceeded 900s on Ethereum, epoch 18,402", source: "engine", fields: { _tag: "engine", subject: "merkl-engine", error: "computeRewards timeout", txHash: null }, sessionId: SESSION.review, triage: auto("Agent-resolvable runtime_error (actionable 82% · agent 61%)", jev("runtime_error", 0.82, 0.81, 0.1, "deep", 1.9)) }),
    critique: alert(clock, { channel: DEV, minutesAgo: 16, title: "merkl-api · 502s on /v4/rewards for Linea", summary: "Grafana: 502 rate 4.8% on /v4/rewards?chainId=59144 for 12 minutes", source: "generic", sessionId: SESSION.critique, triage: auto("Agent-resolvable runtime_error (actionable 89% · agent 82%)", jev("runtime_error", 0.89, 0.82, 0.06, "standard", 2.0)) }),
    watch: {
      ...alert(clock, {
        channel: { ...WATCH_CHANNEL, enabled: true }, minutesAgo: 3, title: "API 5xx at 640 per 5 min, usually up to 43",
        summary: "Since 11:45 UTC, API 5xx has been 15× its usual level for the past 3 hours. Deploys around it: merkl-api v1.35.11 deployed at 11:41 UTC. Bridgetown saw this in Grafana; no Slack alert has fired for it.",
        source: "watch", fields: { _tag: "watch", signal: "api_5xx", query: `k8s.container.name:="envoy" envoy.response_code:>=500 | stats count() n`, datasource: "logs", level: 640, usual: 43, since: ago(18), shape: "rise" },
        triage: { decision: "suggest", reason: "Agent-resolvable runtime_error (actionable 88% · agent 81%)", jev: jev("runtime_error", 0.88, 0.81, 0.02, "standard", 2.1) },
      }),
      id: `watch:api_5xx:${tsAgo(18)}`,
      permalink: "https://grafana.internal.merkl.xyz/d/pihjbxm",
      fingerprint: "watch:api_5xx",
    },
    logs: {
      ...alert(clock, {
        channel: { ...WATCH_CHANNEL, enabled: true }, minutesAgo: 9, title: "merkl-precompute-* and 1 more: Error fetching batch 1/1: Error: Max retries (2) exceeded for request: Rate limi…",
        summary: "Steady: 1,813 lines in the last 15 minutes, about as often as over the 2 hours before. Logged by merkl-precompute-*, merkl-compute-* (v1.62.35) at warning level since 11:51 UTC. Bridgetown found this in the logs; no Slack alert has fired for it.",
        raw: "Pattern (numbers collapsed to <N>): Error fetching batch <N>/<N>: Error: Max retries (<N>) exceeded for request: Rate limited: the preview community blocks subgraphs are being retired, and this shared endpoint is now throttled and will be removed without further notice.\nJev: problem 94% · agent 58% · users affected 43%",
        source: "watch", fields: { _tag: "watch", signal: "log:1234567890", query: `(severity_text:="WARN" OR severity_text:="WARNING") (merkl.job:~"^merkl-precompute-[0-9]+$" OR merkl.job:~"^merkl-compute-[0-9]+$") "and this shared endpoint is now throttled and will be"`, datasource: "logs", level: 1813, usual: 1790, since: ago(24), shape: "rise" },
        triage: { decision: "suggest", reason: "Jev: likely a real problem (problem 94% · agent 58% · users 43%)", jev: jev("runtime_error", 0.94, 0.58, 0, "standard", 1.3) },
      }),
      id: `watch:log:1234567890:${tsAgo(24)}`,
      permalink: "https://grafana.internal.merkl.xyz/explore",
      fingerprint: LOG_FINDING_FINGERPRINT,
    },
    investigate: alert(clock, { channel: UPTIME, minutesAgo: 7, title: "Incident started on api.merkl.xyz/v4/roots/delay", summary: "Better Stack: 3 of 5 regions failing, HTTP 504 after 30s", source: "uptime", fields: { _tag: "uptime", target: "api.merkl.xyz/v4/roots/delay", state: "incident" }, triage: { decision: "suggest", reason: "Borderline uptime_incident (actionable 71% · agent 46%)", jev: jev("uptime_incident", 0.71, 0.46, 0.18, "standard", 2.4) } }),
    escalated: alert(clock, { channel: DM_HUGO, minutesAgo: 1, title: "Hugo Lextrait · DM: should we prioritise the sparkline work over the studio revamp?", summary: "Direct message asking for a prioritisation call", raw: "should we prioritise the sparkline work over the studio revamp?", source: "inbox", fields: inbox("U04HUGO", "Hugo Lextrait", "dm"), triage: { decision: "escalate", reason: "A decision only you can make (needs you 90% · agent 4%)", jev: jev("decision_or_approval", 0.9, 0.04, 0, "quick", 1.6) } }),
    opened: alert(clock, { channel: PRODUCT, minutesAgo: 45, title: "Baptiste · #product: review #3336 when you get a chance?", summary: "PR review request", raw: "<@U03ALEX> review https://nocturlab.ghe.com/Merkl/monorepo/pull/3336 when you get a chance?", source: "inbox", fields: inbox("U04BAPTISTE", "Baptiste", "mention", pr(3336)), triage: { decision: "escalate", reason: "PR reviews always go to you", jev: jev("pr_review", 0.95, 0.1, 0.02, "quick", 1.2) }, events: [{ minutesAgo: 40, text: "Opened by you in Slack or Revv" }], disposition: { kind: "opened", minutesAgo: 40 } }),
    dismissed: alert(clock, { channel: DEV, minutesAgo: 131, title: "merkl-api · p95 latency 1.4s on /v4/campaigns", summary: "Grafana: p95 above 1.2s for 10 minutes, error rate normal", raw: "*[FIRING:1] merkl-api p95 latency*\n*Summary:* p95 latency 1.41s on /v4/campaigns (threshold 1.2s) for 10m\n*Error rate:* 0.2% (normal)", source: "generic", triage: { decision: "suggest", reason: "Borderline runtime_error (actionable 58% · agent 44%)", jev: jev("runtime_error", 0.58, 0.44, 0.22, "standard", 1.3) }, events: [{ minutesAgo: 118, text: "Dismissed by you, no agent started" }], disposition: { kind: "dismissed", minutesAgo: 118 } }),
    ignored: alert(clock, { channel: RELEASES, minutesAgo: 63, title: "merkl-api v1.35.9 · Deployed", summary: "Approval ✓ · Build ✓ · Production ✓", source: "releases", triage: { decision: "ignore", reason: "Not actionable (actionable 3%)", jev: jev("informational", 0.03, 0.02, 0, "quick", 0.1) } }),
    filtered: alert(clock, { channel: INFRA, minutesAgo: 66, title: "SSL certificate for merkl.xyz expires in 7 days", summary: "cert-manager will renew automatically at 30 days remaining", source: "uptime", fields: { _tag: "uptime", target: "merkl.xyz", state: "ssl_expiry" }, triage: { decision: "filtered", reason: "Certificate notices are handled by cert-manager", jev: null } }),
    teammate: alert(clock, { channel: DEV, minutesAgo: 33, title: "merkl-api · 504s on /v4/campaigns/leaderboard", summary: "Grafana: 504 rate 2.2% for 8 minutes", source: "generic", triage: { decision: "filtered", reason: "Julien's agent is on it", jev: null }, claimedBy: [{ userId: "U04JULIEN", name: "Julien", via: "agent", latest: "Fix PR: https://nocturlab.ghe.com/Merkl/monorepo/pull/3351" }, { userId: "U04HUGO", name: "Hugo Lextrait", via: "eyes", latest: null }] }),
    teammateEyes: alert(clock, { channel: ENGINE, minutesAgo: 52, title: "Keeper gas balance low on Gnosis", summary: "merkl-keeper: 0.8 xDAI left (threshold 2)", source: "engine", fields: { _tag: "engine", subject: "merkl-keeper", error: "gas balance low", txHash: null }, triage: { decision: "filtered", reason: "Baptiste is on it", jev: null }, claimedBy: [{ userId: "U04BAPTISTE", name: "Baptiste", via: "eyes", latest: null }] }),
    filteredDeploy: alert(clock, { channel: RELEASES, minutesAgo: 372, title: "merkl-app v2.14.0 · Deployed", summary: "Approval ✓ · Build ✓ · Production ✓", source: "releases", triage: { decision: "filtered", reason: "Deployed", jev: null } }),
    // Settled this morning: more than Recent lists before "Show more".
    claimedHydration: alert(clock, { channel: DEV, minutesAgo: 12, title: "merkl-app · hydration errors on /campaigns/[id]", summary: "Sentry: 212 events in 10 minutes, Safari only", source: "generic", triage: { decision: "filtered", reason: "Pierre is on it", jev: null }, claimedBy: [{ userId: "U03PIERRE", name: "Pierre", via: "eyes", latest: null }] }),
    dismissedRpc: alert(clock, { channel: ENGINE, minutesAgo: 21, title: "RPC latency high on Polygon", summary: "merkl-engine: eth_call p95 2.1s on the primary Polygon RPC", source: "engine", fields: { _tag: "engine", subject: "merkl-engine", error: "eth_call p95 2.1s", txHash: null }, triage: { decision: "suggest", reason: "Borderline onchain_or_keeper (actionable 57% · agent 49%)", jev: jev("onchain_or_keeper", 0.57, 0.49, 0.1, "standard", 1.2) }, events: [{ minutesAgo: 19, text: "Dismissed by you, no agent started" }], disposition: { kind: "dismissed", minutesAgo: 19 } }),
    openedCopy: alert(clock, { channel: PRODUCT, minutesAgo: 58, title: "Hugo Lextrait · #product: can you look at the claim flow copy?", summary: "Review request", raw: "<@U03ALEX> can you look at the claim flow copy before Thursday?", source: "inbox", fields: inbox("U04HUGO", "Hugo Lextrait", "mention"), triage: { decision: "escalate", reason: "A decision only you can make (needs you 86% · agent 5%)", jev: jev("informational", 0.86, 0.05, 0, "quick", 0.9) }, events: [{ minutesAgo: 55, text: "Opened by you in Slack or Revv" }], disposition: { kind: "opened", minutesAgo: 55 } }),
    claimedPrices: alert(clock, { channel: DEV, minutesAgo: 77, title: "merkl-api · 429s from the CoinGecko price feed", summary: "Grafana: 429 rate 12% on price refresh for 9 minutes", source: "generic", triage: { decision: "filtered", reason: "Julien's agent is on it", jev: null }, claimedBy: [{ userId: "U04JULIEN", name: "Julien", via: "agent", latest: `Fix PR: ${pr(3349)}` }] }),
    dismissedDisk: alert(clock, { channel: INFRA, minutesAgo: 96, title: "Disk 82% on clickhouse-2", summary: "node-exporter: /var/lib/clickhouse at 82% (threshold 80%)", source: "generic", triage: { decision: "suggest", reason: "Borderline infra_or_cert (actionable 54% · agent 38%)", jev: jev("infra_or_cert", 0.54, 0.38, 0.05, "quick", 1.1) }, events: [{ minutesAgo: 90, text: "Dismissed by you, no agent started" }], disposition: { kind: "dismissed", minutesAgo: 90 } }),
    dismissedUptime: alert(clock, { channel: UPTIME, minutesAgo: 118, title: "Incident started on app.merkl.xyz", summary: "Better Stack: 1 of 5 regions failing for 40s", source: "uptime", fields: { _tag: "uptime", target: "app.merkl.xyz", state: "incident" }, triage: { decision: "suggest", reason: "Borderline uptime_incident (actionable 52% · agent 30%)", jev: jev("uptime_incident", 0.52, 0.3, 0.2, "quick", 1.4) }, events: [{ minutesAgo: 112, text: "Dismissed by you, no agent started" }], disposition: { kind: "dismissed", minutesAgo: 112 } }),
    // What the release tracker posts for the tag the deploying session cut, as the live mock's does.
    tracker: {
      ...alert(clock, {
        channel: RELEASES, minutesAgo: 38, title: "Deployment api-v1.35.11", summary: "", raw: "", source: "releases",
        fields: { _tag: "release", image: "merkl-api", version: "v1.35.11", actor: "alex", runId: null, runUrl: null, tag: "api-v1.35.11", stages: [{ name: "Approval", status: "pending", detail: "" }] },
        triage: { decision: "filtered", reason: "Release tracker", jev: null },
      }),
      permalink: null,
      fingerprint: "release:api-v1.35.11",
    },
  }

  const S = {
    running: options.static
      ? session(A.running, "running", { started: 8, updated: 0.5 }, {
          activity: RUNNING_NOTE, phase: "fix", rootCauseFound: true, costUsd: 0.42, milestones: { ...NO_MILESTONES, diagnosed: true },
          diagnosis: "Campaigns created since v1.35.9 can have a null reward token until their first distribution, and `OpportunityService.computeApr` reads it unguarded.",
        })
      : { ...newSession(A.running, SESSION.running, options.repoPath), startedAt: ago(8) },
    ask: options.static
      ? session(A.ask, "waiting", { started: 25, updated: 2 }, { activity: `Asked: ${truncate(ASK.question, 100)}`, costUsd: 0.31, milestones: { ...NO_MILESTONES, diagnosed: true } })
      : { ...newSession(A.ask, SESSION.ask, options.repoPath), startedAt: ago(25) },
    ci: session(A.ci, "ci", { started: 37, updated: 3 }, {
      activity: "CI running on #3340", phase: "ci", outcome: "fix_pr", rootCauseFound: true, prUrl: pr(3340), ciRounds: 1, costUsd: 1.84, review: reviewed,
      diagnosis: "vite 6.4.0 (pulled in by a caret range) changed how `import.meta.glob` resolves eager imports, breaking the route manifest in apps/studio. Pinning vite to 6.3.5 restores it.",
      releasePrefix: "studio", milestones: shipped({}),
    }),
    merge: session(A.merge, "awaiting_merge", { started: 69, updated: 12 }, {
      activity: "#3345 approved and green, ready to merge", phase: "ci", outcome: "fix_pr", rootCauseFound: true, prUrl: pr(3345), costUsd: 0.97, review: reviewed,
      diagnosis: "The sparkline component imports `d3-shape` from a path that only exists in d3 v7; the lockfile resolved v6 after a dedupe. Import from the package root.",
      releasePrefix: "app", milestones: shipped({ ciGreen: true }),
    }),
    release: session(A.release, "awaiting_release", { started: 109, updated: 30 }, {
      activity: "Merged, ready to cut dispute-v0.4.3", phase: "deploy", outcome: "fix_pr", rootCauseFound: true, prUrl: pr(3338), costUsd: 0.62, review: reviewed,
      diagnosis: "The Dockerfile copies `bun.lockb`, which the repo replaced with `bun.lock`. Copy the new lockfile.",
      releasePrefix: "dispute", milestones: shipped({ ciGreen: true, merged: true }), mergeRequestedAt: ago(31),
    }),
    inFlight: session(A.inFlight, "awaiting_release", { started: 149, updated: 2 }, {
      activity: "Merged, ready to cut indexer-v0.9.3", phase: "deploy", outcome: "fix_pr", rootCauseFound: true, prUrl: pr(3336), costUsd: 0.88, review: reviewed,
      diagnosis: "Base image pulls hit Docker Hub's anonymous rate limit on the shared runner. Pull from the GHCR mirror instead.",
      releasePrefix: "indexer", milestones: shipped({ ciGreen: true, merged: true }), mergeRequestedAt: ago(20),
    }),
    deploying: session(A.deploying, "deploying", { started: 189, updated: 15 }, {
      activity: "Waiting for release approval", phase: "deploy", outcome: "fix_pr", rootCauseFound: true, prUrl: pr(3333), costUsd: 1.21, review: reviewed,
      diagnosis: "The ETL job's new migration adds a NOT NULL column without a default; existing rows fail it. Added a default and a backfill.",
      releasePrefix: "api", milestones: shipped({ ciGreen: true, merged: true, released: true }),
      mergeRequestedAt: ago(40), releaseTag: "api-v1.35.11", deployStage: { _tag: "AwaitingApproval" },
    }),
    resolved: session(A.resolved, "resolved", { started: 297, updated: 250 }, {
      activity: "Deployed admin-v0.6.1", phase: "done", outcome: "fix_pr", rootCauseFound: true, prUrl: pr(3329), costUsd: 1.31, review: reviewed, worktree: null,
      diagnosis: "A caret range let vite 6.4.0 in, which changed eager `import.meta.glob` resolution and emptied the route manifest. Pinned vite to 6.3.5.",
      releasePrefix: "admin", milestones: shipped({ ciGreen: true, merged: true, released: true, deployed: true }),
      resolution: "deployed admin-v0.6.1", mergeRequestedAt: ago(280), releaseTag: "admin-v0.6.1", deployStage: { _tag: "Deployed" },
    }),
    closed: session(A.closed, "closed", { started: 418, updated: 380 }, {
      activity: "Closed by you", outcome: "needs_human", rootCauseFound: false, costUsd: 1.46, pushbacks: 1, resolution: "root cause not found",
      diagnosis: "Best hypothesis, unconfirmed: the signer's nonce 48,211 was built and signed at 09:41:07 UTC but never broadcast, so the 14 transactions after it sit in the mempool. Either `TxSender.flush` swallowed a JSON-RPC error body, or the nightly rebalancer raced for the nonce. Re-broadcasting 48,211 would unblock the queue but moves funds, so a person has to do it.",
      milestones: { ...NO_MILESTONES },
    }),
    failedCi: session(A.failedCi, "failed", { started: 598, updated: 540 }, {
      activity: "Agent stopped: error_max_turns", phase: "ci", outcome: "fix_pr", rootCauseFound: true, prUrl: pr(3302), ciRounds: 2, costUsd: 3.92,
      diagnosis: "The exporter's Dockerfile pins a Debian image whose apt mirror is gone; switching to bookworm fixes the build, but the integration test then times out against the staging RPC.",
      releasePrefix: "states-exporter", milestones: shipped({}), resolution: "agent stopped: error_max_turns",
    }),
    failedSetup: session(A.failedSetup, "failed", { started: 139.6, updated: 139 }, {
      activity: "Could not start: git fetch: The requested URL returned error: 403", worktree: null, claudeSessionId: null, costUsd: 0,
      resolution: "Could not start: git fetch: The requested URL returned error: 403",
    }),
    stopped: session(A.stopped, "stopped", { started: 248, updated: 236 }, {
      activity: "Stopped by you", rootCauseFound: null, costUsd: 0.41, resolution: "stopped by you", milestones: { ...NO_MILESTONES, diagnosed: true },
      diagnosis: null,
    }),
    reply: session(A.reply, "waiting", { started: 5.5, updated: 1.5 }, {
      activity: "Reproduced it: an empty chainId parses as NaN and slips past validation; fix is a one-line coercion.", outcome: "recommendation", rootCauseFound: true, costUsd: 0.58,
      diagnosis: "`chainId=\"\"` is parsed as `NaN`, which slips past the zod schema and makes `getChain()` throw. Coercing empty strings to undefined fixes it.",
      milestones: { ...NO_MILESTONES, diagnosed: true },
    }),
    review: session(A.review, "waiting", { started: 23, updated: 4 }, {
      activity: "Could not reproduce the timeout locally", outcome: "needs_human", rootCauseFound: false, costUsd: 1.12, pushbacks: 1,
      diagnosis: "Couldn't reproduce the timeout: the same epoch computes in **212s** locally against an archive node.\n\nRuled out:\n- RPC latency (p99 180ms)\n- the campaign config (unchanged)\n- memory (61% peak)\n\nThe slow part in the failing run is `fetchPositions` for 3 Uniswap v4 pools (18k sequential calls); a cold cache on the engine pod is possible but unproven.",
    }),
    critique: session(A.critique, "critiquing", { started: 15, updated: 0.5 }, {
      activity: "Waiting for review", phase: "critique", outcome: "fix_pr", rootCauseFound: true, prUrl: pr(3352), costUsd: 0.86,
      diagnosis: "Linea's RPC returns reward amounts as hex strings above 2^53; `Number()` in `RewardService.format` overflows to Infinity and JSON serialisation fails. Parse with BigInt.",
      releasePrefix: "api", milestones: shipped({ critiqued: false }),
    }),
  } satisfies Record<keyof typeof SESSION, Session>

  /** Static only: an alert that just came in and one whose worktree is being made. */
  const STILL_A = {
    queued: alert(clock, { channel: UPTIME, minutesAgo: 0.5, title: "merkl-api · /v4/claims timing out in 2 regions", summary: "Better Stack: 2 of 5 regions timing out after 30s", source: "uptime", fields: { _tag: "uptime", target: "api.merkl.xyz/v4/claims", state: "incident" }, sessionId: STILL_SESSION.queued, triage: auto("Agent-resolvable uptime_incident (actionable 84% · agent 78%)", jev("uptime_incident", 0.84, 0.78, 0.1, "standard", 2.2)) }),
    preparing: alert(clock, { channel: DEV, minutesAgo: 1.2, title: "merkl-api · 5xx rate 1.9% on /v4/positions", summary: "Sentry: RangeError: Invalid time value in PositionService.since", source: "generic", sessionId: STILL_SESSION.preparing, triage: auto("Agent-resolvable runtime_error (actionable 86% · agent 80%)", jev("runtime_error", 0.86, 0.8, 0.05, "quick", 1.6)) }),
  }
  const STILL_S = {
    queued: { ...newSession(STILL_A.queued, STILL_SESSION.queued, options.repoPath), startedAt: ago(0.4), updatedAt: ago(0.4) },
    preparing: session(STILL_A.preparing, "preparing", { started: 1, updated: 0.8 }, { activity: "Creating worktree…", claudeSessionId: null }),
  } satisfies Record<keyof typeof STILL_SESSION, Session>

  const card = (spec: Omit<Action, "id" | "createdAt" | "url" | "options" | "fingerprint" | "retry"> & Partial<Pick<Action, "url" | "options" | "fingerprint" | "retry">> & { readonly minutesAgo: number }): Action => {
    const { minutesAgo, ...rest } = spec
    return { options: [], url: null, fingerprint: null, retry: false, ...rest, id: `a_mock_${spec.kind}_${spec.sessionId ?? spec.alertId ?? ""}`.replace(/[^a-z0-9_]/gi, "_"), createdAt: ago(minutesAgo) }
  }
  const forSession = (s: Session) => ({ sessionId: s.id, alertId: s.alertId })

  const actions: ReadonlyArray<Action> = [
    card({ kind: "escalate", title: A.escalated.title, detail: A.escalated.triage.reason, primaryLabel: "Open in Slack", sessionId: null, alertId: A.escalated.id, fingerprint: A.escalated.fingerprint, url: A.escalated.permalink, minutesAgo: 1 }),
    card({ kind: "reply", title: "Reply to Pierre", detail: "Reproduced: /opportunities 500s when chainId is empty because the param parses as NaN and slips past validation. A one-line fix coerces empty strings to undefined; I can open the PR.", primaryLabel: "Send reply", ...forSession(S.reply), minutesAgo: 1.5 }),
    card({ kind: "review", title: `Root cause not found · ${S.review.title}`, detail: S.review.diagnosis ?? "", primaryLabel: "Close session", ...forSession(S.review), minutesAgo: 4 }),
    card({ kind: "investigate", title: A.logs.title, detail: `Grafana · ${A.logs.triage.reason}`, primaryLabel: "Investigate", sessionId: null, alertId: A.logs.id, fingerprint: A.logs.fingerprint, minutesAgo: 9 }),
    card({ kind: "investigate", title: A.watch.title, detail: `Grafana · ${A.watch.triage.reason}`, primaryLabel: "Investigate", sessionId: null, alertId: A.watch.id, fingerprint: A.watch.fingerprint, minutesAgo: 3 }),
    card({ kind: "investigate", title: A.investigate.title, detail: `#${A.investigate.channelName} · ${A.investigate.triage.reason}`, primaryLabel: "Investigate", sessionId: null, alertId: A.investigate.id, fingerprint: A.investigate.fingerprint, minutesAgo: 7 }),
    card({ kind: "merge", title: "Merge fix(app): import d3-shape from the package root", detail: "#3345 · approved by julien · CI green, 6 checks · Codex passed", primaryLabel: "Merge", ...forSession(S.merge), minutesAgo: 12 }),
    card({ kind: "release", title: `Ship ${S.release.title}`, detail: releaseDetail(pr(3338), "dispute-v0.4.3", "dispute"), primaryLabel: "Cut dispute-v0.4.3", ...forSession(S.release), minutesAgo: 30 }),
    card({ kind: "release", title: `Ship ${S.inFlight.title}`, detail: releaseDetail(pr(3336), IN_FLIGHT_TAG, "indexer"), primaryLabel: `Cut ${IN_FLIGHT_TAG}`, ...forSession(S.inFlight), minutesAgo: 20 }),
    card({ kind: "review", title: `Agent failed · ${S.failedSetup.title}`, detail: "Could not start: git fetch: The requested URL returned error: 403 (the Merkl IP allow list refused this network)", primaryLabel: "Retry", ...forSession(S.failedSetup), retry: true, minutesAgo: 139 }),
    card({ kind: "review", title: `Agent failed · ${S.failedCi.title}`, detail: "Agent stopped: error_max_turns", primaryLabel: "Retry", ...forSession(S.failedCi), retry: true, minutesAgo: 540 }),
    // Live, the asking agent puts this card up itself.
    ...(options.static ? [card({ kind: "answer", title: ASK.question, detail: S.ask.title, primaryLabel: "Reply", options: ASK.options, ...forSession(S.ask), minutesAgo: 2 })] : []),
  ]

  const t = (minutesAgo: number, kind: TranscriptEntry["kind"], text: string): TranscriptEntry => ({ at: ago(minutesAgo), kind, text })
  /** Live, the scripted agents write these as they go. */
  const stillTranscripts: Readonly<Record<string, ReadonlyArray<TranscriptEntry>>> = {
    [SESSION.running]: [
      t(8, "status", "Session started"),
      t(7.6, "tool", "Bash bun run scripts/logs.ts --app merkl-api --grep TypeError --since 30m"),
      t(7.1, "text", "412 errors in 30 minutes, all from `OpportunityService.computeApr` when `campaign.rewardToken` is null."),
      t(6.4, "tool", "Read packages/api/src/services/opportunity.ts"),
      t(5.9, "text", "Root cause: campaigns created since v1.35.9 can have a null reward token until their first distribution."),
      t(5.5, "status", RUNNING_NOTE),
      t(4.2, "tool", "Edit packages/api/src/services/opportunity.ts"),
      t(2.8, "tool", "Bash bun test packages/api --filter apr"),
      t(0.5, "text", "2 tests fail: the fixture campaign still has a reward token. Updating it."),
    ],
    [SESSION.ask]: [
      t(25, "status", "Session started"),
      t(23.5, "tool", "Bash bun run scripts/keeper-status.ts --chain arbitrum"),
      t(21, "text", "eth_estimateGas has returned 429 from the primary Arbitrum RPC for 2 hours, so every root update attempt fails before it is sent."),
      t(18, "tool", "Read packages/keeper/src/config/rpc.ts"),
      t(2, "status", `Asked: ${ASK.question}`),
    ],
    [STILL_SESSION.preparing]: [t(1, "status", `Fetching origin/main and creating worktree on ${STILL_S.preparing.branch} (then bun install)…`)],
  }
  const transcripts: Readonly<Record<string, ReadonlyArray<TranscriptEntry>>> = {
    ...(options.static ? stillTranscripts : {}),
    [SESSION.ci]: [
      t(37, "status", "Session started"),
      t(36.8, "tool", "Bash gh run view 11873345 --log-failed"),
      t(36.2, "text", "The release build fails in `vite build` for apps/studio: `import.meta.glob` returns an empty object for ./routes/**/*.tsx."),
      t(34.9, "tool", "Bash bun pm ls vite"),
      t(34.1, "text", "bun.lock resolved vite@6.4.0 via ^6.3.0. 6.4 changed eager glob resolution."),
      t(31, "tool", "Edit apps/studio/package.json"),
      t(30.4, "tool", "Bash bun install && bun run --filter studio build"),
      t(27.9, "tool", "Bash gh pr create --title \"fix(app-studio): pin vite to 6.3\""),
      t(27.5, "result", "Pinned vite to 6.3.5; build passes locally. PR #3340."),
      t(26.8, "status", "Review requested in #product-approvals"),
      t(19.2, "error", "CI round 1: typecheck failed in packages/ui"),
      t(12.6, "tool", "Bash gh pr checks 3340"),
      t(9.4, "status", "Resumed with a follow-up"),
    ],
    [SESSION.closed]: [
      t(418, "status", "Session started"),
      t(415, "tool", "Bash bun run scripts/nonce.ts --chain base"),
      t(410, "text", "Nonce 48,211 was signed at 09:41:07 UTC and never broadcast. 14 later transactions are stuck behind it."),
      t(404, "tool", "Read packages/tx-executor/src/TxSender.ts"),
      t(398, "text", "Two leads, neither confirmed:\n1. swallowed JSON-RPC errors in `TxSender.flush`\n2. a nonce race with the nightly rebalancer"),
      t(395, "status", "Bridgetown sent the agent back: it handed off without a confirmed root cause"),
      t(386, "result", "Root cause not confirmed; re-broadcasting 48,211 needs a human."),
    ],
    [SESSION.failedCi]: [
      t(598, "status", "Session started"),
      t(590, "tool", "Edit apps/states-exporter/Dockerfile"),
      t(570, "tool", "Bash gh pr checks 3302"),
      t(560, "error", "CI round 2: integration test timed out against the staging RPC"),
      t(540, "error", "Agent stopped: error_max_turns"),
    ],
    [SESSION.failedSetup]: [
      t(139.6, "status", "Fetching origin/main and creating worktree on fix-bt-dispute-bot-health-check-failing-on-polygon-etup (then bun install)…"),
      t(139, "error", "Could not start: git fetch: The requested URL returned error: 403"),
    ],
    [SESSION.reply]: [
      t(5.5, "status", "Session started"),
      t(5.1, "tool", "Bash curl -s 'localhost:3000/v4/opportunities?chainId=' -w '%{http_code}'"),
      t(4.8, "text", "500 · TypeError: Cannot read properties of undefined (reading 'name') at getChain"),
      t(1.5, "result", "Drafted a reply for Pierre."),
    ],
    [SESSION.review]: [
      t(23, "status", "Session started"),
      t(19.8, "tool", "Bash bun run engine:compute --campaign 0x4f1c…a9e2 --epoch 18402"),
      t(15.1, "text", "Computed in 212s locally. No timeout."),
      t(9, "status", "Bridgetown sent the agent back: it handed off without a confirmed root cause"),
      t(4, "result", "Could not reproduce the timeout locally"),
    ],
    [SESSION.merge]: [
      t(69, "status", "Session started"),
      t(66, "tool", "Bash gh run view 291250190 --log-failed"),
      t(63, "text", "`d3-shape/src/curve` is only exported by d3 v7; the lockfile dedupe resolved v6."),
      t(58, "tool", "Edit apps/app/src/components/Sparkline.tsx"),
      t(55, "tool", "Bash gh pr create --title \"fix(app): import d3-shape from the package root\""),
      t(54, "result", "Imports from the package root; build passes. PR #3345."),
      t(40, "status", "Review requested in #product-approvals"),
    ],
    [SESSION.release]: [
      t(109, "status", "Session started"),
      t(104, "text", "The Dockerfile still copies `bun.lockb`, which the repo replaced with `bun.lock`."),
      t(101, "tool", "Edit apps/dispute/Dockerfile"),
      t(98, "result", "Copies the new lockfile; docker build passes. PR #3338."),
      t(31, "status", "Merged #3338"),
    ],
    [SESSION.inFlight]: [
      t(149, "status", "Session started"),
      t(144, "text", "Docker Hub's anonymous pull limit is hit on the shared runner; GHCR mirrors the same base image."),
      t(141, "tool", "Edit apps/indexer/Dockerfile"),
      t(138, "result", "Pulls from the GHCR mirror. PR #3336."),
      t(20, "status", "Merged #3336"),
    ],
    [SESSION.deploying]: [
      t(189, "status", "Session started"),
      t(183, "tool", "Bash bun run --filter api migrate:status"),
      t(178, "text", "Migration 0141 adds `campaigns.etl_version NOT NULL` without a default; production has 41k rows."),
      t(171, "tool", "Edit packages/db/migrations/0141_campaign_etl_version.sql"),
      t(166, "result", "Added a default and a backfill. PR #3333."),
      t(40, "status", "Merged #3333"),
      t(15, "status", "Released api-v1.35.11"),
    ],
    [SESSION.critique]: [
      t(15, "status", "Session started"),
      t(13.5, "tool", "Bash bun run scripts/logs.ts --app merkl-api --grep 502 --since 20m"),
      t(12.2, "text", "Every 502 is a `TypeError: Do not know how to serialize Infinity` from `RewardService.format`, only on Linea."),
      t(8.1, "tool", "Edit packages/api/src/services/reward.ts"),
      t(5.4, "tool", "Bash gh pr create --draft --title \"fix(api): parse Linea reward amounts as BigInt\""),
      t(5, "result", "Parse amounts with BigInt. Draft PR #3352."),
    ],
    [SESSION.stopped]: [t(248, "status", "Session started"), t(240, "tool", "Bash bun run scripts/latency.ts --route /v4/campaigns"), t(236, "status", "Stopped by you")],
    [SESSION.resolved]: [t(297, "status", "Session started"), t(281, "result", "Pinned vite to 6.3.5. PR #3329."), t(250, "status", "Deployed admin-v0.6.1")],
  }

  const fakePr = (title: string, checks: MockPr["checks"], review: MockPr["review"], merged = false): MockPr => ({ title, checks, review, merged, moves: false })
  const prs: Readonly<Record<string, MockPr>> = {
    [pr(3340)]: fakePr("fix(app-studio): pin vite to 6.3", "pending", "REVIEW_REQUIRED"),
    [pr(3345)]: fakePr("fix(app): import d3-shape from the package root", "green", "APPROVED"),
    [pr(3338)]: fakePr("fix(dispute): copy bun.lock in the Dockerfile", "green", "APPROVED", true),
    [pr(3336)]: fakePr("fix(indexer): pull base images from GHCR", "green", "APPROVED", true),
    [pr(3302)]: fakePr("fix(states-exporter): move to bookworm", "red", "REVIEW_REQUIRED"),
    [pr(3352)]: { ...fakePr("fix(api): parse Linea reward amounts as BigInt", "pending", "REVIEW_REQUIRED"), moves: true },
  }
  const tags = ["admin-v0.6.0", "admin-v0.6.1", "app-v2.15.0", "api-v1.35.10", "api-v1.35.11", "dispute-v0.4.2", "indexer-v0.9.2", "studio-v1.4.0"]

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    channels: DEFAULT_SETTINGS.channels.map((c) => (c.name === "alert-infra" ? { ...c, enabled: false } : c)),
    dryRun: false,
    // The two scripted agents never finish; room for the ones you start.
    maxConcurrent: 4,
    monorepoPath: options.repoPath,
    deploymentRepoPath: options.repoPath,
    quietHours: { enabled: true, start: "22:00", end: "08:00" },
  }

  const sessions: ReadonlyArray<Session> = [...Object.values(S), ...(options.static ? Object.values(STILL_S) : [])]
  /** Each session's alert says it started, and (once over) how it ended, as the real repo writes it. */
  const alerts: ReadonlyArray<Alert> = [...Object.values(A), ...(options.static ? Object.values(STILL_A) : [])].map((a) => {
    const s = sessions.find((x) => x.id === a.sessionId)
    if (s === undefined) return a
    const started = { at: s.startedAt, text: sessionStartEvent(s) }
    const ended = isFinished(s) ? [{ at: s.updatedAt, text: sessionEndEvent(s) }] : []
    return { ...a, events: [...a.events, started, ...ended] }
  })

  if (options.world === "empty") return { alerts: [], sessions: [], actions: [], transcripts: {}, prs: {}, tags: [], settings }
  return { alerts: [...alerts, ...background(clock)], sessions, actions, transcripts, prs, tags, settings }
}

/**
 * A day of the routine traffic that never reaches Recent's first page: successful
 * deploys and recoveries filtered by rules, chatter Jev ignored. Fills the overview's
 * 24h chart. Deterministic, so screenshots compare.
 */
const background = (clock: Clock): ReadonlyArray<Alert> => {
  const images = ["merkl-api", "merkl-app", "merkl-studio", "merkl-indexer", "merkl-engine", "merkl-admin"]
  // Alerts per hour, oldest first: a quiet night, a busy working day.
  const perHour = [1, 0, 0, 1, 0, 0, 0, 1, 2, 3, 2, 4, 3, 2, 3, 5, 4, 2, 3, 2, 1, 2, 1, 0]
  return perHour.flatMap((count, hour) =>
    Array.from({ length: count }, (_, i) => {
      const minutesAgo = (23 - hour) * 60 + 5 + ((i * 17 + hour * 7) % 50)
      const image = images[(hour + i) % images.length] ?? "merkl-api"
      const n = (hour * 3 + i) % 4
      return n === 3
        ? alert(clock, { channel: UPTIME, minutesAgo, title: `${image} · Recovered`, summary: "Back up after a 40s blip", source: "uptime", triage: { decision: "filtered", reason: "Recovered", jev: null } })
        : n === 2
          ? alert(clock, { channel: DEV, minutesAgo, title: `${image} · Slow query warning`, summary: "p95 820ms on a cold cache", source: "generic", triage: { decision: "ignore", reason: "Not actionable (actionable 8%)", jev: jev("informational", 0.08, 0.1, 0, "quick", 0.2) } })
          : alert(clock, { channel: RELEASES, minutesAgo, title: `${image} v1.${hour}.${i} · Deployed`, summary: "Approval ✓ · Build ✓ · Production ✓", source: "releases", triage: { decision: "filtered", reason: "Deployed", jev: null } })
    }),
  )
}
