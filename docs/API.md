# Daemon API

The app talks to the daemon over HTTP on `127.0.0.1:<port>`. The default port is `47621`, and the `BRIDGETOWN_PORT` env var overrides it.
Every request but `/health` carries `Authorization: Bearer <token>`. The daemon refuses to start without a token.
The shapes it sends are defined once, in [`daemon/src/api/wire.ts`](../daemon/src/api/wire.ts): see
[The contract](#the-contract).

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

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | | `{ "ok": true, "version": "<daemon version>" }`, with no token |
| GET | `/state` | | `Snapshot` |
| GET | `/events` | | SSE stream. Every change sends `event: snapshot` with `data: <Snapshot JSON>` (at most one per 150ms: a burst shares snapshots, and the last one is always read after the last change). The first message arrives on connect. A `: ping` comment is sent every 15s. |
| GET | `/sessions/:id/transcript` | | `TranscriptEntry[]`: the last 200, oldest first |
| GET | `/boards/:view` | | `Board`: `incidents` (API 5xx and p99, engine and job errors), `infra` (RPC errors, failed job pods, OOM kills, Postgres backends waiting) or `database` (prod Postgres connections by state, backends waiting on locks, longest transaction, replication lag), over the last hour. |
| GET | `/logs` | | `LogSweep`: the last sweep of prod's logs (every 10 minutes, with `watchProd`), its patterns most telling first. Read from the store: never queries Grafana. |
| GET | `/alerts/:id/board` | | `Board` picked from what the alert is about (an API route, a release image, a chain, its kind), 6h either side of it; `null` when nothing in Grafana tracks it (an inbox message). |
| GET | `/alerts/:id` | | `AlertDetail`: the full message, its history, its session (if any) and its open cards. |
| POST | `/actions/:id/resolve` | `{ "response": string \| null }` | `Snapshot`. `409` while the same card is being resolved or dismissed (`inFlight`), or, for merge and release, while another card of the same session's gate is. `409` for a card whose session has moved on (see [Cards](#cards)): it acts on nothing and goes. `409` for a Retry while the failed agent is still winding down; the card stays for a second click. A reply: `400` when the text is empty, `404` when the message it answers is gone; the card stays and nothing is recorded. Merge and release are idempotent per session: a repeat never merges or tags twice. |
| POST | `/actions/:id/dismiss` | | `Snapshot`. `409` while the card is being resolved; a dismiss under way holds off a resolve of it the same way. When `dismissCloses` is true, the session is recorded as closed. Dismissing a question tells the agent you dismissed it. |
| POST | `/alerts/:id/investigate` | | `Snapshot`. Starts a session even if Jev said ignore. |
| POST | `/alerts/:id/feedback` | `{ "label": "good" \| "bad" }` | `Snapshot` |
| POST | `/sessions/:id/stop` | | `Snapshot`. Its cards go. |
| POST | `/sessions/:id/message` | `{ "text": string }` | `Snapshot`. `409` unless `acceptsMessages`. The text is in the transcript at once (`text`, "You: …"). If the agent is blocked on a question (an `answer` card), it answers it and the card goes. Otherwise a running agent reads it at its next step (`activity` "Read your message"); a session between turns resumes with it. A session whose review rounds are spent gets a fresh budget. |
| POST | `/settings` | Part of `Settings` | `Snapshot`. See [Settings](#settings). |
| POST | `/pause` | `{ "paused": boolean }` | `Snapshot`. While paused, alerts are still triaged but nothing auto-starts. It survives a restart. |

An `:id` is URL-encoded: `/alerts/C0AUKD42N3U%3A1790933006.433649`. A POST with no body in the table ignores the one
it gets; for the others an empty body reads as `{}`.

## Errors

Errors return `{ "error": string }`. Between binding the port and finishing startup (recovery) every request,
`/health` included, gets `503`. After that, a request other than `/health` is checked in this order:

1. `403` for a `Host` other than `127.0.0.1` or `localhost`, or any `Origin` header: no browser page reaches the daemon.
2. `401` for a missing or wrong token.
3. `405` for a method other than GET and POST.

Then `400` for a body that is not JSON or not the shape the route takes, or an id with bad percent-encoding; `404` for
an unknown path or id; `409` for a request the current state does not allow; `500` for anything else (Slack refusing a
reply, GitHub Enterprise unreachable, a store error).

## Settings

`POST /settings` takes any part of `Settings` (`daemon/src/domain/settings.ts`) and answers the snapshot with the
settings saved:

- A key left out keeps its value. `thresholds` and `quietHours` merge key by key, so `{ "thresholds": { "autoActionable": 0.9 } }`
  changes that one threshold. Anything else given replaces the whole value: `channels` is the full list.
- Unknown keys are dropped. Every value is checked: thresholds between 0 and 1, `maxConcurrent` a whole number of at
  least 1, `quietHours` times as `HH:MM`, and `pollSeconds` a whole number of at least 10. A value out of range or of
  the wrong type, or `null`, fails the whole request with `400` and changes nothing.
- The merged settings are checked again as a whole, saved in the store, and pushed to every `/events` stream.

Settings stored by an older daemon load over the defaults the same way, so a setting added since takes its default,
and a default channel added since is listed but off.

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

## The contract

Every shape the daemon sends is declared once, with a comment on each field, in
[`daemon/src/api/wire.ts`](../daemon/src/api/wire.ts), and the app's `Models.swift` mirrors it. The view builders in
`daemon/src/api/views.ts` are typed by it. `daemon/test/api/contract.test.ts` runs those builders and pins their
output to the app's test fixtures (`app/Tests/BridgetownTests/Fixtures/`: a snapshot, an alert detail, a board, a log
sweep), which the app's tests decode. A wire change fails that test until the fixtures are rewritten with
`UPDATE_FIXTURES=1 bun test test/api/contract.test.ts` in `daemon/`, then `make test-app` until the app reads them.
Read wire.ts for the fields; what follows is what their names don't say.

**Nulls and times.** Every field is always present; one with no value is `null`, never left out. Timestamps are
ISO-8601 strings, except a chart point's time, which is unix seconds.

**Computed by the daemon.** Outcomes, steps, headlines, tones, `holder`, `critiqueLine`, `ciLine`, `channelLabel`,
`Step.detail` and the `Panel` spike fields are sent ready to render. The app never works them out from other fields,
so a rule changes in one place.

- `tone` is `success` only for an outcome the daemon verified: a session `resolved` (deployed, merged with nothing
  to ship, or a confirmed no-op). `closed` means closed without a fix and is never a success.
- `AlertView.outcome` says what happened to an alert. When a session owns it (`kind` `session`), its headline and tone
  are the session's own. `teammate` means a teammate is on it per Slack, and its `sentence` names who, with the latest
  their Bridgetown posted in the thread. `sentence` is `null` when the headline says it all.
- `channelLabel` is where the alert came from, as written: `#alert-releases`, `DM` or `group DM` for an inbox message
  outside a channel, `Grafana` for a prod finding. A session carries its alert's, or `#<channel>` once the alert is
  gone from the store.
- `Session.steps` is always six, in order: `diagnose`, `fix`, `pr`, `critique`, `ci`, `deploy`. A step is `done` on
  evidence only, so a session never shows more progress than it made. The first step not done is where the session
  is: `current`, `failed` where an ended session stopped, or `pending` while a session past diagnosis waits on
  someone. The steps after it are `pending`. A step that doesn't apply is `skipped` (no review ran, no release needed,
  what a resolved session never needed). A label can say the truth instead of the step's name (`Root cause?`,
  `No PR`, `No review`, `No deploy`, `Deployed`). `detail` is what there is to show under the name, else `null`:
  `Cause found` or `No root cause` for `diagnose`, `#<number>` for `pr`, the `critiqueLine` for `critique`, and the
  `ciLine` for `ci` once CI has run or is running. A pending step, `fix` and `deploy` never have one.
- `holder` is who has the session's next move, which the tone can't say ("In review" is live, yet nobody works on
  it): `agent` (preparing or working), `critic` (the review is running), `you` (a question, a hand-off, a re-run, a
  merge, a release, or a review request that didn't go out), `reviewers` (in review in an approvals channel), `ci`,
  `deploy`, or `queue` (queued, or review findings waiting for a free agent slot). `null` once the session has ended
  (`resolved`, `closed`, `failed`, `stopped`).
- `acceptsMessages` is true for a session that is not queued, preparing or resolved and still has its worktree and
  agent conversation (a running one, its worktree). Housekeeping keeps an ended session's worktree for 24 hours.

**Alerts.** An alert's `id` is `<channelId>:<ts>` for a Slack message, and `watch:<signal>:<since>` for a prod
finding: a rise or spike Bridgetown saw in Grafana, or a log pattern Jev called a problem (signal `log:<hash>`), with
`<since>` in unix seconds. `AlertDetail.raw` is the message as Markdown, translated from Slack's mrkdwn: links, emphasis and
quotes, `<@U…>` as the person's display name (their id when Slack doesn't know it), channels, groups and `<!here>` by
name, common `:shortcodes:` as emoji, code kept as written. The stored message is cut at 4000 characters. A prod
finding's `raw` is Bridgetown's own text: its title and summary, the query behind it, and a link to Grafana. `events`
are its history, oldest first, to render as they are.

**Cards.** `url` is `null` unless it is an `https:`, `slack:` or `revv:` URL, since agents and Slack messages supply
it; the app opens it on the primary button, then resolves. `inFlight` is a resolve running now (merging, cutting a
release): show progress, not the button. `dismissCloses` means dismissing records the session as closed, not fixed,
so the app confirms first; it is false for a card whose session has moved on.

**Boards.** A board over a minute old comes back at once while a fresh one is fetched (`fetchedAt`). When nothing
could be fetched (Grafana MCP down, every query failed) `error` is set and `panels` is empty; otherwise a panel whose
own query failed carries its own `error`. `latest` is the sum of each series' last point. The spike fields come from
the prod watcher's last look, the one judgement of a signal there is, so a chart never calls a spike what the watcher
would not:

- `usual` is the signal's usual level per step of this board, and a step above `spikeAbove` is one the watcher's rule
  calls a spike. Both are `null` for a panel no rule watches, a panel whose query failed, or when the watcher hasn't
  measured it in the last 20 minutes (watching off, Grafana down).
- `spike` is set only on a board whose window ends within 10 minutes of now, and only while the watcher finds the
  signal unusual: how many times its usual level it is (a usual under 1 counts as 1).

**Lists and limits.** A snapshot holds every open card, newest first; the active sessions, then the 20 most recent
finished ones; and the last 30 alerts, newest first. `metrics` counts the sessions started in the last 24 hours across
the whole store, not just those 30 alerts, and how many of them are now `resolved`. A transcript is its last 200
entries. `LogSweep.sweptAt` is `null` until a sweep has been stored (the first runs 2½ minutes after the daemon
starts, then every 10 minutes); `error` says why no sweep runs (watching off, Grafana MCP down), or else which query of
the last sweep failed. Its patterns come suspicious first (new, then surging, then risky warnings), then steady errors,
busiest first within each. A pattern's `jev` is Jev's verdict when it was asked in the last day (only suspicious
patterns are, each at most once a day), else `null`.
