# Daemon API

The menu bar app talks to the daemon over HTTP on `127.0.0.1:<port>`. The default port is `47621`, and the `BRIDGETOWN_PORT` env var overrides it.
Every request but `/health` carries `Authorization: Bearer <token>`. The daemon refuses to start without a token.

## Launch

The app starts the daemon with `BRIDGETOWN_SECRETS=stdin` and writes one JSON line to its stdin, then keeps the pipe open:

```json
{ "apiToken": "<random>", "slackUserToken": "xoxp-…", "typesafeApiKey": "…" }
```

An empty string counts as missing: an empty `apiToken` stops the daemon (exit 1), an empty Slack token or TypeSafe key
shows as `missing_token` / `missing_key`. Secrets never travel in the environment, so agent sessions and their
subprocesses cannot read them. The daemon exits when its stdin closes, so it never outlives the app. For development, `BRIDGETOWN_API_TOKEN`, `SLACK_USER_TOKEN` and
`TYPESAFE_API_KEY` are still read from the environment; the daemon removes them from `process.env` at startup either way.

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
| GET | `/boards/:view` | | `Board`: `incidents` (API 5xx and p99, engine and job errors) or `infra` (RPC errors, failed job pods, OOM kills, Postgres backends waiting), over the last hour. |
| GET | `/alerts/:id/board` | | `Board` picked from what the alert is about (an API route, a release image, a chain, its kind), 6h either side of it; `null` when nothing in Grafana tracks it (a DM). |
| GET | `/alerts/:id` | | `AlertDetail` — the full message, its history, its session (if any) and open actions. `:id` is URL-encoded (`C0AUKD42N3U%3A1790933006.433649`). |
| POST | `/actions/:id/resolve` | `{ "response": string \| null }` | `Snapshot`. `409` while the same action is already being resolved (`inFlight`). Merge and release are idempotent per session: a repeat never merges or tags twice. |
| POST | `/actions/:id/dismiss` | `{}` | `Snapshot`. When `dismissCloses` is true, the session is recorded as closed. |
| POST | `/alerts/:id/investigate` | `{}` | `Snapshot`. Starts a session even if Jev said ignore. |
| POST | `/alerts/:id/feedback` | `{ "label": "good" \| "bad" }` | `Snapshot` |
| POST | `/sessions/:id/stop` | `{}` | `Snapshot` |
| POST | `/sessions/:id/message` | `{ "text": string }` | `Snapshot`. `409` unless `acceptsMessages`. The text is in the transcript at once (`text`, "You: …"). If the agent is blocked on a question (an `answer` card), it answers it and the card goes. Otherwise a running agent reads it at its next step (`activity` "Read your message"); a session between turns resumes with it. |
| POST | `/settings` | `Partial<Settings>` | `Snapshot` |
| POST | `/pause` | `{ "paused": boolean }` | `Snapshot`. While paused, alerts are still triaged but nothing auto-starts. |
| POST | `/poll` | `{}` | `Snapshot`. Polls Slack now. Serialized with the poll loop, never concurrent with it. |

Errors return `{ "error": string }`: `400` for a malformed body, `401` for a bad token, `404` for an unknown id, `409`
for a request the current state does not allow, `405` for a method no route takes, `500` for anything else (Slack refusing a reply, GitHub Enterprise unreachable, a store error). Between binding the port and finishing startup
(recovery) every request, `/health` included, gets `503`. A non-loopback `Host` or any `Origin` header gets `403`.

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

type Status = {
  paused: boolean
  dryRun: boolean
  slack: "ok" | "error" | "missing_token"
  jev: "ok" | "error" | "missing_key"
  grafanaMcp: "up" | "down"
  github: "ok" | "blocked" | "unknown"   // blocked = GHE IP allow list refuses this network; sessions stay queued. Not repeated in `error`
  lastPollAt: string | null
  error: string | null   // last error worth surfacing, one line
}

type AlertView = {
  id: string             // "<channelId>:<ts>"
  channelId: string
  channelName: string    // e.g. "alert-releases"
  ts: string
  permalink: string | null
  title: string          // "merkl-admin v0.6.0 · Build failed"
  summary: string        // one line
  source: "releases" | "uptime" | "engine" | "inbox" | "generic"   // inbox = a mention / group mention / DM anywhere in Slack, including a person's message in an alert channel
  receivedAt: string
  triage: Triage
  sessionId: string | null
  feedback: "good" | "bad" | null
  outcome: AlertOutcome  // what happened to it, computed by the daemon. Render this, never infer from triage or history text.
}

type AlertOutcome = {
  kind: "pending" | "filtered" | "ignored" | "suggested" | "escalated" | "waiting" | "dismissed" | "opened" | "session"
  // waiting   = an open card for this alert is in "Needs you"
  // dismissed = you dismissed its card and no agent ran · opened = you opened it in Slack/Revv from an escalation
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
  decision: "pending" | "filtered" | "ignore" | "suggest" | "auto" | "escalate"   // escalate = Jev says this needs you personally
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
  status: "queued" | "preparing" | "running" | "waiting" | "ci" | "awaiting_merge" | "awaiting_release" | "deploying" | "resolved" | "closed" | "failed" | "stopped"
  // resolved = a verified outcome (deployed, merged with nothing to ship, or confirmed no-op).
  // closed   = the user closed it without a fix. Never rendered as success.
  steps: Step[]            // always 5, in order; computed from evidence by the daemon. Render these, never infer.
  headline: string         // status line, e.g. "Running", "Waiting on you", "Resolved · deployed admin-v0.6.1", "Closed · root cause not found"
  tone: "live" | "waiting" | "success" | "neutral" | "failure"   // color of the status dot and headline. success only for verified outcomes
  resolution: string | null  // for finished sessions: the honest one-line outcome
  rootCauseFound: boolean | null
  activity: string         // latest one-line activity ("Reading failed job logs…")
  diagnosis: string | null
  outcome: "fix_pr" | "recommendation" | "no_action" | "needs_human" | null
  prUrl: string | null
  branch: string | null
  worktree: string | null
  claudeSessionId: string | null
  model: string
  ciRounds: number
  costUsd: number
  slackThreadUrl: string | null
  acceptsMessages: boolean // POST /sessions/:id/message is allowed: live, or finished and handed back with its worktree intact
  revvUrl: string | null     // revv://pr?host=…&repo=…&number=… — opens the PR walkthrough in Revv
  reviewChannel: string | null  // "product-approvals" once a review was requested there
  reviewUrl: string | null   // permalink of that review request
  startedAt: string
  updatedAt: string
}

type Step = {
  key: "diagnose" | "fix" | "pr" | "ci" | "deploy"
  label: string            // "Diagnose", "Fix", "PR", "CI", "Deploy" (may read "Root cause?", "No PR", "Merged" when that is the truth)
  state: "done" | "current" | "pending" | "failed" | "skipped"
  // done = evidence it happened · current = in progress now · pending = not reached (hollow)
  // failed = this is where it stopped or broke · skipped = not applicable (e.g. no release needed)
}

type Action = {
  id: string
  kind: "investigate" | "merge" | "release" | "rerun" | "answer" | "grafana" | "review" | "reply" | "escalate"
  // review: the agent finished without a fix (or failed). primaryLabel is "Retry" (re-runs the agent) or "Close session"
  //         (records it as closed, not fixed). Show the agent's detail; offer "Reply to agent" by opening the session.
  // reply: the agent drafted a reply to a teammate; `detail` is the draft. Resolve with { response: editedText } to send it in the thread.
  // escalate: a message that needs you personally. Primary button opens `url` (Slack permalink or revv:// link), then resolves.
  title: string            // "Merge fix(app-admin): pin vite to 6.3"
  detail: string           // one or two lines
  primaryLabel: string     // button text: "Investigate", "Merge", "Cut admin-v0.6.1", "Re-run", "Reply", "Retry", "Send", "Open in Slack", "Open in Revv"
  options: string[]        // for kind=answer: quick replies (may be empty → free text)
  sessionId: string | null
  alertId: string | null
  url: string | null       // when set, the app opens it on the primary button (before resolving). Only https:, slack: and revv: URLs.
  inFlight: boolean        // a resolve is running (merging, tagging a release…); show progress, don't offer the button
  dismissCloses: boolean   // dismissing records the session as closed, not fixed; the app confirms and says so
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
  }
  autoStart: boolean            // false → every candidate becomes "suggest"
  inbox: boolean                // watch mentions, group mentions and DMs across all of Slack
  maxConcurrent: number         // 2
  dryRun: boolean               // never post to Slack
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
