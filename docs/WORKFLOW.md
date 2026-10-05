# How Bridgetown works

[← Back to the README](../README.md)

Decision policy, session boundaries, and what Bridgetown posts to Slack.

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
  thresholds in Settings. Each verdict is stored with its numbers, and 👍/👎 in the app labels it for calibration.
- **Depth picks the model.** `quick` runs Sonnet at medium effort, `standard` runs Opus at high, `deep` runs Opus at max. Only that local table names models.
- **Another vendor reviews every fix.** Agents open PRs as drafts. Before a pushed fix goes to CI, Codex (never the coder's own vendor:
  `REVIEWER_FOR` in `daemon/src/triage/policy.ts`) reviews the diff adversarially in a read-only sandbox (`daemon/src/critique/`). Jev
  judges each finding (`real_defect`, `blocking`, and from round 2 whether the agent's reply already `rebutted` it) and the policy
  drops the nitpicks. Blocking findings go back to the same agent conversation; it fixes them or rebuts them with evidence, and the
  new head is reviewed again, up to 4 rounds before it is handed to you. Once a review passes, Bridgetown takes the PR out of draft
  and the ship flow (CI, review request, merge) carries on. Toggle it in **Settings → Behaviour**.
- **Bridgetown also watches prod itself, and investigates what it finds.** Every 5 minutes it reads the overview's signals (API 5xx
  and p99, engine and job errors, eRPC errors, failed job pods, OOM kills, DB waits) over the last 3 hours from the Grafana MCP
  (`daemon/src/watch/`), against each signal's 90th percentile before the last 15 minutes. Two kinds of anomaly count: a **rise**,
  the median of the last three 5-minute steps above a floor and a multiple of that usual level, and a **spike**, one step alone far
  above it (API 5xx: at least 100 and 4× usual). Engine and job errors swing 10–600 as jobs run, so their floors sit above a normal
  day's peaks: their job cycles start nothing. If no Slack alert from the last 2 hours covers the same signal, the anomaly becomes a
  finding in channel "Grafana", with the dashboard as its link and recent deploys in its summary, and **an investigation starts on
  it**, the way Auto-start starts one for an alert (paused, or with Auto-start off, it waits in Needs you). Jev judges it for the
  agent's depth; one Jev sees nothing in (most one-step spikes on a normal day), or with Jev unavailable, is only suggested. A signal raises at most one finding every 6 hours unless it gets 3× worse; a rise whose
  card is still waiting is withdrawn once the signal is back to usual, a spike's is not. The agent is told there is no Slack thread,
  and that a rise or spike with no cause is closed with no action, not a code change. Toggle it in **Settings → Behaviour**.
- **And it sweeps prod's logs.** Every 10 minutes it groups prod's log lines into patterns (one message with numbers collapsed,
  merged across the jobs that log it; `daemon/src/watch/logs.ts`): errors over the last day, and warnings that name a risk
  (deadlock, rate limited, retired, reverted…) over the last 2 hours. An error pattern is a candidate when it is new or at least 5×
  its usual rate; a risky warning is one even when steady, since a retirement notice never spikes. Up to 12 candidates go to Jev in
  one call, three yes/no questions each (`daemon/src/watch/judge.ts`): is it a real problem, is it agent work, are users affected.
  Counts and rates are worked out in code and given to Jev as a sentence. Each pattern is judged at most once a day, and that memory
  survives restarts. A pattern Jev calls a problem (above the suggest threshold) becomes a finding linked to its lines in Grafana
  Explore, and gets an investigation like a metric anomaly; it is handed to the agent already on it if one is running, and past
  two starts in one sweep (a bad deploy logs many patterns at once) the rest are suggested. The queries are constants: nothing from a log line goes into a query Bridgetown runs.
  Every pattern of the last sweep shows under **Prod → Logs**, suspicious ones first with Jev's verdict and their finding, each opening its lines in Grafana Explore (`GET /logs`).

## Safety model

Sessions are headless, so `monorepo/AGENTS.md`'s prod-safety hard rule applies in full:

- **No secrets in reach.** The app hands the daemon its tokens over stdin (see [API.md](API.md)), and every process the
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
