# Daemon API

The app talks to the daemon over HTTP on `127.0.0.1:<port>`. The default port is `47621`, and the `BRIDGETOWN_PORT` env var overrides it.
Every request but `/health` carries `Authorization: Bearer <token>`. The daemon refuses to start without a token.

## Launch

The app starts the daemon with `BRIDGETOWN_SECRETS=stdin` and writes one JSON line to its stdin, then keeps the pipe open:

```json
{ "apiToken": "<random>", "slackUserToken": "xoxp-…", "typesafeApiKey": "…" }
```

This line is the only way in for secrets. Without `BRIDGETOWN_SECRETS=stdin`, or without an `apiToken` on the line, the
daemon exits 1 before it binds the port. An empty Slack token or TypeSafe key shows as `missing_token` / `missing_key`.
Secrets never travel in the environment, where the kernel keeps a copy any of the user's processes can read: the app
strips `BRIDGETOWN_API_TOKEN`, `SLACK_USER_TOKEN` and `TYPESAFE_API_KEY` from the daemon's environment, and the daemon
strips every `BRIDGETOWN_*`, `SLACK_*` and `TYPESAFE_*` variable from what it spawns. The daemon ignores later lines on
stdin (the mock reads them as control lines) and exits when stdin closes, so it never outlives the app.

The app picks what to run in this order:

1. `BRIDGETOWN_DAEMON_CMD`: a command it runs as `/bin/sh -c "exec <cmd>"`, so one command
   (`bun /abs/path/daemon/src/main.ts`), not a list. `make dev` runs the daemon from source this way.
2. `BRIDGETOWN_ATTACH=1`: no child; it attaches to a daemon already running, with `BRIDGETOWN_API_TOKEN`. `make dev-app`
   attaches to `make mock`, which answers the token `dev` when started by hand (or `BRIDGETOWN_API_TOKEN`).
3. `bridgetown-daemon` in the app bundle.

With none of them it says no daemon is bundled. The daemon's output goes to `daemon.log` in
`~/Library/Logs/Bridgetown`, or in `BRIDGETOWN_LOG_DIR`, which only the app reads.

The daemon binds the port before touching the store. If the port is taken it exits with status 98 and prints
`port <n> in use` on stderr, so a second daemon never runs recovery on a store another daemon owns.
All timestamps are ISO-8601 strings. Every nullable field is always present, set to `null` when it has no value.

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | | `{ "ok": true, "version": "0.1.0" }` (no auth) |
| GET | `/state` | | `Snapshot` |
| GET | `/events` | | SSE stream. Every change sends `event: snapshot` with `data: <Snapshot JSON>` (at most one per 150ms: a burst shares snapshots, and the last one is always read after the last change). The first message arrives on connect. A `: ping` comment is sent every 15s. |
| GET | `/sessions/:id/transcript` | | `TranscriptEntry[]` (last 200) |
| GET | `/boards/:view` | | `Board`: `incidents` (API 5xx and p99, engine and job errors), `infra` (RPC errors, failed job pods, OOM kills, Postgres backends waiting) or `database` (prod Postgres connections by state, backends waiting on locks, longest transaction, replication lag), over the last hour. |
| GET | `/logs` | | `LogSweep`: the last sweep of prod's logs (every 10 minutes, with `watchProd`), its patterns most telling first. Read from the store: never queries Grafana. |
| GET | `/alerts/:id/board` | | `Board` picked from what the alert is about (an API route, a release image, a chain, its kind), 6h either side of it; `null` when nothing in Grafana tracks it (a DM). |
| GET | `/alerts/:id` | | `AlertDetail` — the full message, its history, its session (if any) and open actions. `:id` is URL-encoded (`C0AUKD42N3U%3A1790933006.433649`). |
| POST | `/actions/:id/resolve` | `{ "response": string \| null }` | `Snapshot`. `409` while the same card is being resolved or dismissed (`inFlight`), or, for merge and release, while another card of the same session's gate is. `409` for a card whose session has moved on (see [Cards](#cards)): it acts on nothing and goes. `409` for a Retry while the failed agent is still winding down; the card stays for a second click. A reply: `400` when the text is empty, `404` when the message it answers is gone; the card stays and nothing is recorded. Merge and release are idempotent per session: a repeat never merges or tags twice. |
| POST | `/actions/:id/dismiss` | `{}` | `Snapshot`. `409` while the card is being resolved; a dismiss under way holds off a resolve of it the same way. When `dismissCloses` is true, the session is recorded as closed. Dismissing a question tells the agent you dismissed it. |
| POST | `/alerts/:id/investigate` | `{}` | `Snapshot`. Starts a session even if Jev said ignore. |
| POST | `/alerts/:id/feedback` | `{ "label": "good" \| "bad" }` | `Snapshot` |
| POST | `/sessions/:id/stop` | `{}` | `Snapshot`. Its cards go. |
| POST | `/sessions/:id/message` | `{ "text": string }` | `Snapshot`. `409` unless `acceptsMessages`. The text is in the transcript at once (`text`, "You: …"). If the agent is blocked on a question (an `answer` card), it answers it and the card goes. Otherwise a running agent reads it at its next step (`activity` "Read your message"); a session between turns resumes with it. A session whose review rounds are spent gets a fresh budget. |
| POST | `/settings` | `Partial<Settings>` | `Snapshot` |
| POST | `/pause` | `{ "paused": boolean }` | `Snapshot`. While paused, alerts are still triaged but nothing auto-starts. |
| POST | `/poll` | `{}` | `Snapshot`. Polls Slack now. Serialized with the poll loop, never concurrent with it. |

Errors return `{ "error": string }`: `400` for a malformed body, `401` for a bad token, `404` for an unknown id, `409`
for a request the current state does not allow, `405` for a method no route takes, `500` for anything else (Slack refusing a reply, GitHub Enterprise unreachable, a store error). Between binding the port and finishing startup
(recovery) every request, `/health` included, gets `503`. Any other request with a non-loopback `Host` or any `Origin` header gets `403`.

## Cards

A card stands only while its session is at the stage it was offered for: a merge card while the session waits to
merge, a release card while it waits for its release, a re-run or a hand-off while it waits on you, a Retry while it
has failed, a question while the agent is still asking it. The write that moves the session on (a gate passed, the PR
going red, a turn starting, the session ending) takes its dead cards with it, and a gate the session comes back to
offers a fresh card. Investigate, escalate and reply cards have no stage to leave (a reply can still be sent once its
session has ended); an investigate card goes when an agent or a teammate takes its alert on, when its alert is triaged
again to nothing to do (a failed build re-run green) or is a rise that is back to normal, or when a newer
alert of the same problem replaces it.

- **Merge** asks GitHub first and records nothing when the call fails, so the next click tries again. A merge GitHub
  queues instead of doing (a merge queue) is GitHub's to finish; the Merge card comes back only if it hasn't merged
  within an hour. A session waiting to merge goes back to CI, and its Merge card goes, when the PR's checks go red or
  run again, or it gets changes requested or needs a review again. A PR closed on GitHub closes its session
  (`Closed · PR closed without merging`).
- **Hand-offs** are `review` cards titled `<why> · <session title>`, whose button closes the session. An agent that
  finishes without a fix hands off this way (`Recommendation`, `Root cause not found`, `Needs you`, `Unverified`). Red
  CI, requested changes and a failed deploy go back to the agent, up to 3 rounds between them, then to you (`CI still
  red`, `Changes requested`, `Deploy keeps failing`). A send-back the agent answers without a fix comes to you too:
  `CI still red`, `Changes requested` or `Deploy failed` (after a failed deploy, a fix with no new PR counts as none).
  So do a release nobody approved for 24 hours (`Release not approved`) and a deploy the tracker hasn't moved for 3
  hours (`Deploy stalled`).
- **Questions** (`answer`) last only as long as the agent's call: an answer, your message, 30 minutes without one, a
  stop or a crash ends it and the card goes. A daemon that restarts while an agent works or asks brings the session
  back failed, with an `Interrupted` Retry card that resumes the agent's conversation.

## Types

```ts
type Snapshot = {
  status: Status
  actions: Action[]      // "Needs you", newest first
  sessions: Session[]    // active sessions first, then the 20 most recent finished ones
  alerts: AlertView[]    // last 30 alerts, newest first
  metrics: Metrics       // the last 24h, counted over the whole store (not just the 30 alerts above)
  settings: Settings
}

type Metrics = {
  since: string          // start of the window: 24h ago
  sessions: {            // sessions started in the window
    started: number
    resolved: number
    failed: number
    closed: number       // closed or stopped without a verified fix
    costUsd: number
  }
}

// A small Grafana dashboard: `GET /boards/:view` and `GET /alerts/:id/board`. Read through the
// local grafana MCP container (read-only tools only); the daemon never calls Grafana itself.
type Board = {
  title: string          // "Incidents", "API · /v4/opportunities", "merkl-api", "Chain 42161"…
  from: string           // the window
  to: string
  stepSeconds: number    // one point per step; count panels count per step
  marker: string | null  // when the alert fired, for an alert's board
  panels: Panel[]
  deploys: Deploy[]      // newest first: the window (72h for a release's image)
  fetchedAt: string      // a board over a minute old comes back at once while a fresh one is fetched
  error: string | null   // nothing could be fetched (Grafana MCP down…); panels is then []
}

type Panel = {
  id: string
  title: string
  unit: "count" | "ms" | "per_s" | "bytes"
  series: Array<{ label: string, points: Array<[number, number]> }>  // [unix seconds, value], oldest first
  latest: number | null  // sum of each series' last point (e.g. all pods across versions)
  link: string           // the Grafana dashboard over the board's window, for the browser
  error: string | null   // this panel's query failed; the others still show
}

type Deploy = {
  at: string
  image: string          // "merkl-api"
  version: string        // "v1.35.11"
  stage: string          // "engine", "front-production", or where it failed
  status: "deployed" | "failed"   // deployed = a prod stage succeeded; a green build alone is not a deploy
}

// The log sweep (`GET /logs`): prod's error lines over the last day and risky warnings over the last 2 hours,
// grouped into patterns (one message, numbers collapsed, merged across the jobs that log it).
type LogSweep = {
  sweptAt: string | null // the last sweep; null before the first (2½ minutes after the daemon starts)
  link: string           // Grafana Explore: prod's error lines over the last 3 hours
  error: string | null   // why no sweep runs ("Prod watching is off…", Grafana MCP down), else a query of the last sweep that failed
  patterns: LogPattern[] // suspicious first (new, then surging, then risky warnings), then steady errors; busiest first within each
}

type LogPattern = {
  key: string
  level: "error" | "warning"
  behaviour: "new" | "surging" | "steady"   // new = no line in the window before the last 15 minutes · surging = ≥ 5× its usual rate
  suspicious: boolean    // what the sweep asks Jev about: a new or surging error, or any risky warning. Steady errors are the day's noise
  sources: string[]      // jobs or services that logged it, busiest first: "merkl-compute-*", "api"
  message: string        // numbers collapsed to <N>
  example: string        // one real line
  versions: string[]     // image tags that logged it, up to 3
  recent: number         // lines in the last 15 minutes
  usual: number          // lines per 15 minutes over the rest of the window
  jev: { problem: number; agent: number; users: number; at: string } | null   // Jev's verdict (0..1 each), asked at most once a day; null when not asked
  alertId: string | null // the finding it raised (Jev called it a problem): GET /alerts/:id
  link: string           // Grafana Explore on its lines, from 3 hours before the sweep to now
}

type Status = {
  paused: boolean
  dryRun: boolean
  slack: "ok" | "error" | "missing_token"
  jev: "ok" | "error" | "missing_key"
  grafanaMcp: "up" | "down"
  github: "ok" | "blocked" | "unknown"   // blocked = GHE IP allow list refuses this network; sessions stay queued. Not repeated in `error`
  lastPollAt: string | null
  error: string | null   // the latest problem still standing, one line. Each part (Slack, the alert poll, the inbox, user groups,
                         // posts, Jev, MCP, CI, session setup) clears its own once it works again
}

type AlertView = {
  id: string             // "<channelId>:<ts>", or "watch:<signal>:<since>" / "watch:log:<pattern>:<at>" for a prod finding
  channelId: string
  channelName: string    // e.g. "alert-releases"
  ts: string             // Slack message ts; for a watch finding, the start of the rise in unix seconds
  permalink: string | null
  title: string          // "merkl-admin v0.6.0 · Build failed"
  summary: string        // one line; a watch finding's is a few sentences (the rise, deploys around it)
  source: "releases" | "uptime" | "engine" | "inbox" | "generic" | "watch"   // inbox = a mention / group mention / DM anywhere in Slack, including a person's message in an alert channel
                                                                           // watch = a prod signal Bridgetown saw rise in Grafana itself: channelName "Grafana", permalink = the Grafana dashboard, no Slack thread
  receivedAt: string
  triage: Triage
  sessionId: string | null
  feedback: "good" | "bad" | null
  claimedBy: Claimant[]  // teammates on it per Slack, first claim first; never you. [] for inbox items
  outcome: AlertOutcome  // what happened to it, computed by the daemon. Render this, never infer from triage or history text.
}

type Claimant = {
  userId: string
  name: string           // Slack display name
  via: "agent" | "eyes"  // agent = their Bridgetown posted "🤖 Investigating with Bridgetown…" in the thread · eyes = they reacted 👀
  latest: string | null  // their Bridgetown's latest thread post, without the 🤖 ("Fix PR: https://…")
}

type AlertOutcome = {
  kind: "filtered" | "ignored" | "suggested" | "escalated" | "waiting" | "dismissed" | "opened" | "withdrawn" | "teammate" | "session"
  // waiting   = an open card for this alert is in "Needs you"
  // dismissed = you dismissed its card and no agent ran · opened = you opened it in Slack/Revv from an escalation
  // withdrawn = its card was withdrawn before anyone acted: a Bridgetown finding whose signal went back to normal ("Back to normal")
  // teammate  = no session of yours, and a teammate is on it (`claimedBy`): "Julien's agent is on it", "Baptiste is on it (+1)"
  // session   = an agent session owns it; headline and tone are the session's own
  headline: string       // "Filtered by a rule", "Ignored by Jev", "Waiting on you", "Dismissed by you", "Resolved · deployed admin-v0.6.1"
  sentence: string | null  // one longer line for the detail view: what happened when no agent ran ("No agent ran. Jev ignored it."); null for a session, whose steps say it
  tone: "live" | "waiting" | "success" | "neutral" | "failure"   // success only for a session the daemon verified
}

type AlertDetail = {
  alert: AlertView
  raw: string                                    // the Slack message as text (mrkdwn), up to 4000 chars
  events: { at: string; text: string }[]         // oldest first: "Ignored by Jev: …", "Dismissed by you, no agent started", "Agent session started (…)",
                                                 // "Agent session ended · <session headline>" when its session finishes (resolved, closed, failed, stopped),
                                                 // e.g. "Agent session ended · Closed · root cause not found", and "Agent session resumed" if a retry or
                                                 // your message brings it back. Render these lines as they are; do not synthesize a session-end line.
  session: Session | null                        // its steps/headline/resolution say how the work ended
  actions: Action[]                              // still-open cards for this alert
}

type Triage = {
  decision: "filtered" | "ignore" | "suggest" | "auto" | "escalate"   // escalate = Jev says this needs you personally
  reason: string         // human-readable, one line
  jev: Jev | null        // null when a cheap rule decided, or Jev was unavailable
}

type Jev = {
  actionable: number       // 0..1
  agentResolvable: number  // 0..1
  humanOnIt: number        // 0..1
  kind: string             // alerts: build_failure | deploy_failure | runtime_error | uptime_incident | onchain_or_keeper | infra_or_cert | informational
                           // inbox: code_change | investigation | technical_question | test_request | pr_review | decision_or_approval | personal_or_social | fyi
  kindConfidence: number   // 0..1
  depth: "quick" | "standard" | "deep"
  urgency: number          // expected score 0..3
}

type Session = {
  id: string
  alertId: string
  title: string
  channelName: string
  status: "queued" | "preparing" | "running" | "waiting" | "critiquing" | "ci" | "awaiting_merge" | "awaiting_release" | "deploying" | "resolved" | "closed" | "failed" | "stopped"
  // resolved = a verified outcome (deployed, merged with nothing to ship, or confirmed no-op).
  // closed   = the user closed it without a fix. Never rendered as success.
  // critiquing = another vendor's model is reviewing the pushed fix; the PR is a draft until it passes.
  steps: Step[]            // always 6, in order; computed from evidence by the daemon. Render these, never infer.
  headline: string         // status line, e.g. "Agent working", "Waiting on you", "Resolved · deployed admin-v0.6.1", "Closed · root cause not found", "Closed · PR closed without merging"
  tone: "live" | "waiting" | "success" | "neutral" | "failure"   // color of the status dot and headline. success only for verified outcomes
  reviewerName: string     // who reviews the agent's fixes, e.g. "Codex"
  critiqueLine: string     // where the adversarial review stands: "Reviewing · round 2", "Passed · 1 round of fixes · 2 dropped by Jev", "1 blocking finding · agent fixing", "Not run"
  resolution: string | null  // for finished sessions: the honest one-line outcome
  rootCauseFound: boolean | null
  activity: string         // latest one-line activity ("Reading failed job logs…")
  diagnosis: string | null
  outcome: "fix_pr" | "recommendation" | "no_action" | "needs_human" | null
  prUrl: string | null     // only from the agent's structured result, and only a PR on Merkl/monorepo (a link into one is stored as the PR's own URL)
  branch: string | null
  worktree: string | null
  claudeSessionId: string | null
  model: string
  ciRounds: number
  critiqueRounds: number   // times the adversarial review sent the agent back on this PR
  critique: {              // the last adversarial review of the pushed head; null before the first
    reviewer: "codex"
    passed: boolean
    blocking: number       // findings sent back to the agent
    dropped: number        // findings Jev judged nitpicks (style, speculation, already answered)
  } | null
  costUsd: number
  slackThreadUrl: string | null
  acceptsMessages: boolean // POST /sessions/:id/message is allowed: live, or finished and handed back with its worktree still there
                           // (closed, stopped or failed within the last 24h). Never queued, preparing or resolved
  revvUrl: string | null     // revv://pr?host=…&repo=…&number=… — opens the PR walkthrough in Revv
  reviewChannel: string | null  // "product-approvals" once a review was requested there
  reviewUrl: string | null   // permalink of that review request
  startedAt: string
  updatedAt: string
}

type Step = {
  key: "diagnose" | "fix" | "pr" | "critique" | "ci" | "deploy"
  label: string            // "Diagnose", "Fix", "PR", "Review", "CI", "Deploy" (may read "Root cause?", "No PR", "No review", "No deploy", "Deployed" when that is the truth)
  state: "done" | "current" | "pending" | "failed" | "skipped"
  // done = evidence it happened · current = in progress now · pending = not reached (hollow)
  // failed = this is where it stopped or broke · skipped = not applicable (e.g. no release needed)
}

type Action = {
  id: string
  kind: "investigate" | "merge" | "release" | "rerun" | "answer" | "review" | "reply" | "escalate"
  // review: the session is handed to you (the agent finished without a fix, a send-back came back without one, the ship flow
  //         stalled: see Cards) or it failed. primaryLabel is "Retry" (re-runs the agent) or "Close session"
  //         (records it as closed, not fixed). Show the agent's detail; offer "Reply to agent" by opening the session.
  // reply: the agent drafted a reply to a teammate; `detail` is the draft. Resolve with { response: editedText } to send it in the thread.
  // escalate: a message that needs you personally. Primary button opens `url` (Slack permalink or revv:// link), then resolves.
  title: string            // "Merge fix(app-admin): pin vite to 6.3"
  detail: string           // one or two lines
  primaryLabel: string     // button text: "Investigate", "Merge", "Cut admin-v0.6.1", "Re-run failed jobs", "Reply", "Retry", "Close session", "Send reply", "Open in Slack", "Open in Revv"
  options: string[]        // for kind=answer: quick replies (may be empty → free text)
  sessionId: string | null
  alertId: string | null
  url: string | null       // when set, the app opens it on the primary button (before resolving). Only https:, slack: and revv: URLs.
  inFlight: boolean        // a resolve is running (merging, tagging a release…); show progress, don't offer the button
  dismissCloses: boolean   // dismissing records the session as closed, not fixed; the app confirms and says so. False for a card whose session moved on
  createdAt: string
}

type Settings = {
  channels: { id: string; name: string; enabled: boolean }[]
  thresholds: {
    autoActionable: number      // 0.8
    autoResolvable: number      // 0.75
    autoHumanOnItMax: number    // 0.3
    suggestActionable: number   // 0.5
    suggestResolvable: number   // 0.4
    findingReal: number         // 0.6 — a review finding goes back to the agent only if Jev judges it a real defect ≥ this,
    findingBlocking: number     // 0.5 —   blocking ≥ this,
    findingRebutted: number     // 0.6 —   and not already answered by the agent (rebutted < this)
  }
  autoStart: boolean            // false → every candidate becomes "suggest"
  inbox: boolean                // watch mentions, group mentions and DMs across all of Slack
  maxConcurrent: number         // 2
  dryRun: boolean               // never post to Slack
  adversarialReview: boolean    // true — another vendor's model reviews each pushed fix before the PR leaves draft
  watchProd: boolean            // true — every 5 min, check the overview's prod signals in Grafana for rises and spikes, every 10 sweep prod's logs for new, surging or risky patterns (judged by Jev); each anomaly no Slack alert covers gets an investigation (decision "auto", started per autoStart/paused like an alert's)
  pollSeconds: number           // 30
  monorepoPath: string
  deploymentRepoPath: string
  quietHours: { enabled: boolean; start: string; end: string }  // "22:00"–"08:00"; no notifications, auto-start still runs
}

type TranscriptEntry = {
  at: string
  kind: "text" | "tool" | "result" | "status" | "error"
  text: string
}
```
