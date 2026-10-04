# Bridgetown

A macOS menu bar app that handles Merkl's Slack alerts and requests so you don't have to context-switch.

It watches the `#alert-*` channels plus every mention, team mention and DM addressed to you. For each item it asks
**Jev** (TypeSafe System One) one question: hand this to a Claude agent, or put it in front of you? Agents take
alerts all the way. They diagnose, fix, open a PR, get it green, request review in the approvals channel with a Revv
walkthrough link, then ship the release and watch the deploy. You only click the human gates: **Merge**, **Cut release**, **Send reply**.

```
Slack (poll) ──► parse ──► rules ──► Jev ──► policy ──┬─► auto ──► Claude session (worktree) ──► draft PR ⇄ Codex review ──► CI ──► review ──► merge* ──► release* ──► deploy ✓
                                                     ├─► suggest / escalate ──► "Needs you" in the menu bar (+ notification)
                                                     └─► ignore / filtered ──► Recent
                                                                                       * one click from you
```

## Layout

| Path | What |
|---|---|
| `daemon/` | Bun + Effect v4 daemon. Handles Slack polling, triage, Agent SDK sessions, the ship flow, and HTTP/SSE on `127.0.0.1:47621` |
| `app/` | SwiftUI `MenuBarExtra` app (SwiftPM). Starts the daemon and stores tokens in Keychain |
| `docs/API.md` | The daemon ↔ app contract |
| `slack-app-manifest.yml` | The personal Slack app with the user scopes Bridgetown needs |
| `site/` | The landing page (Astro, three.js). `cd site && bun install && bun run dev`; `bun run build` type-checks and writes `dist/` |

## Setup

1. **Slack:** create an app from `slack-app-manifest.yml`, install it to yourself, and copy the `xoxp-…` user token.
2. **TypeSafe:** get an API key for Jev.
3. **Claude, Codex and GitHub:** `claude` must be logged in, and so must `gh auth status` for `nocturlab.ghe.com`. Sessions reuse both logins.
   The adversarial review runs your own `codex` (`codex login` once; `BRIDGETOWN_CODEX_PATH` if it is not on the app's PATH).
4. **MCP:** run `claude mcp login merkl` once. Sessions that need prod logs need `bun grafana:mcp` running in the monorepo; the menu bar tells you when it is down.
5. Build and run:

```sh
make all            # compiles the daemon and assembles build/Bridgetown.app
open build/Bridgetown.app
```

Paste both tokens in **Settings → Accounts**. The daemon restarts with them.

### Development

```sh
cd daemon && bun install
bun test                                              # parsers, rules, policy, guard, ship helpers
BRIDGETOWN_API_TOKEN=dev bun src/main.ts --dry-run    # never posts to Slack; refuses to start without a token
bun scripts/replay.ts --channel alert-releases --since 14d  # what Jev would have decided on real history
bun scripts/replay-inbox.ts ../.context/replay-inbox.json
BRIDGETOWN_HOME=/tmp/bt-e2e/home bun scripts/e2e-session.ts  # full agent session against a throwaway repo
make mock && make dev-app                             # UI against the mock daemon (below)
```

**Mock daemon** (`daemon/scripts/mock/`, `make mock`): the real daemon (store, runner, ship flow and gates, actions,
HTTP/SSE, views) on a throwaway store, with Slack, Jev, the Agent SDK and GitHub faked, so nothing leaves the machine.
It listens on `127.0.0.1:47621` with token `dev` (`BRIDGETOWN_PORT` / `BRIDGETOWN_API_TOKEN` override) and starts with
a session in every state the app tells apart (running, waiting on an ask, CI, ready to merge, ready to release, a
release in flight, deploying, resolved, closed without a root cause, failed at CI and at setup, stopped) and alerts
that were filtered, ignored, suggested, escalated, dismissed or opened. Two agents run a script: one keeps working
(activity, cost and transcript move, so SSE updates show), the other asks a question with quick replies and carries
on once you answer it, from the card or with a message. Merge and release go through the real gates against a fake
`gh` that takes 3s, so `inFlight` and the 409 for a second click are visible; a cut release is walked through
approval, build and production by a fake release tracker until it resolves. Investigate and Retry start scripted
agents that open a PR, which then goes green and gets approved on its own. Worktrees come from a local git repo.

- `MOCK_EXTRA=1`: the running agent also asks a question (a second answer card).
- `MOCK_GITHUB=blocked`: start with GitHub Enterprise refusing this network; `kill -USR1 <pid>` toggles it.
- `MOCK_RELEASE_HOLD_SECONDS` (600): how long the release in flight at startup takes.

## How decisions are made

- **Alerts are bot posts.** In the `#alert-*` channels only top-level bot messages are alerts. What people write there (a teammate
  pinging you in an alert's thread, or at the top level) is an inbox item; a follow-up in a thread an agent is handling goes to that agent.
- **Rules come first** (`daemon/src/triage/rules.ts`). Successful deploys, releases waiting for approval, recoveries, `[RESOLVED]` and
  `:white_check_mark:` notices are filtered with no model call. A repeat of an alert a session already owns gets attached to that session.
- **Jev on alerts** (`daemon/src/triage/jev.ts`). One `systemOne` call asks several things:
  - `actionable`: does this need action now?
  - `agent_resolvable`: can an agent fix it without prod writes?
  - `human_on_it`: is a teammate already on it?
  - `kind`, `depth` and `urgency`.
- **Jev on inbox items** asks:
  - `needs_me`: is this waiting on you?
  - `delegable`: can an agent do it end to end?
  - `already_handled`: has it been answered already?
  - `kind`, `depth` and `urgency`.

  PR reviews and decisions always escalate to you.
- **One owner per alert, across the team** (`daemon/src/slack/claims.ts`). When several people run Bridgetown, the alert's Slack
  thread records who has it. Before an agent starts, Bridgetown posts `🤖 Investigating with Bridgetown…` there. That post is the
  claim, and the earliest one wins. If two copies post at once, each reads the thread back, and the later one deletes its post and
  does not start. A teammate's claim, or their 👀 on the alert, means you don't get an agent or a card for it. Instead it shows as
  "Julien's agent is on it" or "Baptiste is on it", with the last thing their Bridgetown posted. If someone claims an alert after
  Jev suggested it to you, your card goes. **Investigate anyway** still starts your own agent. Inbox items are yours alone, so
  they are never claimed.
- **Policy** (`daemon/src/triage/policy.ts`) turns probabilities into a decision: auto, suggest, escalate, ignore or filtered. You can tune the
  thresholds in Settings. Each verdict is stored with its numbers, and 👍/👎 in the menu labels it for calibration.
- **Depth picks the model.** `quick` runs Sonnet at medium effort, `standard` runs Opus at high, `deep` runs Opus at max. Only that local table names models.
- **Another vendor reviews every fix.** Agents open PRs as drafts. Before a pushed fix goes to CI, Codex (never the coder's own vendor:
  `REVIEWER_FOR` in `daemon/src/triage/policy.ts`) reviews the diff adversarially in a read-only sandbox (`daemon/src/critique/`). Jev
  judges each finding (`real_defect`, `blocking`, and from round 2 whether the agent's reply already `rebutted` it) and the policy
  drops the nitpicks. Blocking findings go back to the same agent conversation; it fixes them or rebuts them with evidence, and the
  new head is reviewed again, up to 4 rounds before it is handed to you. Once a review passes, Bridgetown takes the PR out of draft
  and the ship flow (CI, review request, merge) carries on. Toggle it in **Settings → Behaviour**.
- **Bridgetown also watches prod itself.** Every 5 minutes it reads the overview's signals (API 5xx and p99, engine and job errors,
  eRPC errors, failed job pods, OOM kills, DB waits) over the last 3 hours from the Grafana MCP (`daemon/src/watch/`). A signal has
  risen when the median of its last three 5-minute steps is above an absolute floor and above a multiple of the 90th percentile of
  the steps before. A one-step burst never counts, and the floors come from a day of real data. If no Slack alert from the last 2 hours
  covers the same signal, the rise becomes a finding in channel "Grafana", with the dashboard as its link and recent deploys in its
  summary. Jev judges it like any alert, but a finding is at most suggested, never auto-started, and it is raised at most once per
  signal every 6 hours. Its agent is told there is no Slack thread, and that a rise with no cause is closed with no action, not a code change.
  Toggle it in **Settings → Behaviour**.
- **And it sweeps prod's logs.** Every 10 minutes it groups prod's log lines into patterns (one message with numbers collapsed,
  merged across the jobs that log it; `daemon/src/watch/logs.ts`): errors over the last day, and warnings that name a risk
  (deadlock, rate limited, retired, reverted…) over the last 2 hours. An error pattern is a candidate when it is new or at least 5×
  its usual rate; a risky warning is one even when steady, since a retirement notice never spikes. Up to 12 candidates go to Jev in
  one call, three yes/no questions each (`daemon/src/watch/judge.ts`): is it a real problem, is it agent work, are users affected.
  Counts and rates are worked out in code and given to Jev as a sentence. Each pattern is judged at most once a day, and that memory
  survives restarts. A pattern Jev calls a problem (above the suggest threshold) becomes a finding linked to its lines in Grafana
  Explore, again only ever suggested. The queries are constants: nothing from a log line goes into a query Bridgetown runs.

## Safety model

Sessions are headless, so `monorepo/AGENTS.md`'s prod-safety hard rule applies in full:

- **No secrets in reach.** The app hands the daemon its tokens over stdin (see `docs/API.md`), and every process the
  daemon spawns, sessions included, gets an environment without `BRIDGETOWN_*`, `SLACK_*` or `TYPESAFE_*`.
- **Bash guard.** A `PreToolUse` hook plus `canUseTool` (`daemon/src/sessions/guard.ts`) parses each command
  (`sessions/shell.ts`: lists, pipes, subshells, `$(…)`, backticks, heredocs) and checks every command it would run,
  through wrappers (`env`, `time`, `xargs`, `timeout`, `nice`, `bash -c`, `eval`, `find -exec`…), path prefixes and
  `git -C/-c` options. A script run with `bash`, `sh`, `source` or `./` is checked by its content. It refuses all of the
  following and tells the agent what to do instead:
  - `gh pr merge`, `gh run rerun` and `gh run cancel`, `gh workflow run`, `gh release`, GitHub API writes, `gh`/`git` aliases
  - creating or pushing tags, force pushes, pushes to any branch except the session's own `fix-bt-*`
  - kubectl, helm, gcloud and `op`, keychain reads, `sudo`
  - migrations, `cast send`, and network calls to `*.internal.merkl.xyz`, Slack, or the daemon's own port
  - piping into a shell, and commands named through a variable or a glob, which it cannot check
- **Writes stay in the worktree.** Edit, Write, MultiEdit and NotebookEdit are refused outside the session's worktree
  (symlinks resolved, `..` refused). Reads stay open.
- **What the guard cannot see.** Code run by an interpreter (`bun x.ts`, `node -e`, `python`), aliases from your own
  shell config, and files written by Bash commands. The real backstops are the missing credentials and GitHub's
  branch protection and `production` environment approval.
- **MCP servers.** Only `merkl` and `grafana` load from the repo's `.mcp.json`, plus Bridgetown's in-process `report` and `ask` tools.
- **Human gates.** Merging, cutting releases, re-running approved pipelines and sending replies to teammates are always your click. GitHub's
  `production` environment approval stays with the reviewer team.
- **Slack text is untrusted.** Jev's criteria and the agent prompts mark it as data, not instructions.
- **Isolation.** Each session works in its own worktree under `monorepo/.shared/worktrees/fix-bt-*`, per the repo's worktree convention.
- **Dry run.** `--dry-run` (or the Settings toggle) stops every Slack post.

## What gets posted as you (🤖-prefixed)

- **In the alert thread:** "Investigating…" (also your claim on the alert, see above), the PR link, a recommendation if there is one, "Released vX", and "Deployed vX ✓".
- **In the approvals channel:** once CI is green, a review request. Product apps go to `#product-approvals` and ping `@dev-product`;
  everything else goes to `#general-approvals` with the owning team. The request includes the PR link and the Revv walkthrough deep link
  (`revv://pr?host=nocturlab.ghe.com&repo=Merkl%2Fmonorepo&number=N`).
- **In a teammate's thread:** a delegated agent's reply, only after you press **Send**.

## Landing page

`site/` is the public page: Astro, with the arch rendered live in three.js (`site/src/scripts/scene.ts`), the notch island
ported from `app/Sources/Bridgetown/Island/` (`site/src/lib/notch.ts`, `site/src/scripts/island.ts`), and the page's
choreography in `site/src/scripts/main.ts`. The access form posts `{ "email": … }` as JSON to `PUBLIC_ACCESS_ENDPOINT`;
without it, the form says requests aren't open yet.

The two videos in `site/public/media/` are recorded from `/film` (dev only): `?cut=keynote` is the 1920 × 1080 film,
`?cut=island` the short notch recording. Record them with Chrome's screencast in real time and encode with ffmpeg
(H.264, `+faststart`).
