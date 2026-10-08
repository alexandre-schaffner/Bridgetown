# How Bridgetown works

[← Back to the README](../README.md)

Decision policy, session boundaries, what Bridgetown keeps, and what it posts to Slack.

## How decisions are made

- **Alerts are bot posts.** In the `#alert-*` channels only top-level bot messages are alerts. What people write there (a teammate
  pinging you in an alert's thread, or at the top level) is an inbox item; a follow-up in a thread an agent is handling goes to that agent.
- **Nothing is lost to an outage** (`daemon/src/intake/`). Each channel is read back to just before its last good read,
  never more than 3 hours (a weekend asleep doesn't replay Friday's alerts), and a burst of more than 15 posts is paged
  back that far. The inbox's place moves only when every search worked. A release tracker a session is following is
  read on its own every poll, however far down the channel it has gone.
- **Rules come first** (`daemon/src/triage/rules.ts`). Successful deploys, releases waiting for approval, recoveries, `[RESOLVED]` and
  `:white_check_mark:` notices are filtered with no model call. A repeat of an alert a session already owns gets attached to that session.
- **Jev on alerts** (`daemon/src/triage/judge.ts`, asked through `daemon/src/jev.ts`). One `systemOne` call asks several things:
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
  thresholds in Settings. Each verdict is stored with its numbers.
- **Models are configured per role.** Settings → Models selects Codex or Claude Code, model and effort independently for monitoring (investigation) and reviewing. Automatic monitoring keeps `quick` Sonnet/medium, `standard` Opus/high and `deep` Opus/max; Automatic reviewing keeps Codex at medium/high/xhigh. New sessions snapshot their monitoring choice; retries and follow-ups retain it. Each new review reads the current reviewing choice, and an in-flight review retains its profile. Jev still chooses depth and judges findings.
- **A reviewer checks every fix.** Agents open PRs as drafts. Before a pushed fix goes to CI, the selected model reviews the diff adversarially without write tools (`daemon/src/critique/`). Codex uses its read-only sandbox; Claude Code gets only Read, Glob and Grep, with no shell, MCP or subagents. The same provider may investigate and review. Jev
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

- **No secrets in reach.** The daemon takes its tokens only on its stdin, from the app or `make dev` (see
  [API.md](API.md#launch)), never from the environment, where any process of yours could read them back. Every process
  it spawns, sessions included, gets an environment without `BRIDGETOWN_*`, `SLACK_*` or `TYPESAFE_*`.
- **Named Claude tools only.** Claude sessions get an explicit list of built-in tools (Bash, Read, Glob, Grep, Edit, Write, NotebookEdit,
  WebSearch, WebFetch, TodoWrite) rather than the CLI's preset, and `Task` is taken away, so a newer tool that runs
  commands or reaches the network (subagents, Monitor, Cron, RemoteTrigger, Workflow) is never offered
  (`daemon/src/agent/options.ts`).
- **One gate over every Claude tool call.** A matcher-less `PreToolUse` hook, with `canUseTool` behind it
  (`daemon/src/guard/hook.ts`), checks each call: a tool that runs a command goes through the command policy, a write
  tool through the worktree boundary, WebFetch's URL through the same host rules as a network command. A call it
  cannot check is refused.
- **Codex investigations stay sandboxed.** Its required `PreToolUse` hook checks shell commands and patches with the
  same command and write policies. Each shell command starts in the directory the hook checked; an explicit `cd`
  inside the command is checked too. The workspace-write sandbox has approvals disabled, and Bridgetown refuses
  requests to expand its permissions. Input to an existing process stays in that process's sandbox.
- **The command policy** (`daemon/src/guard/bash.ts`, `guard/vcs.ts`) parses each command (`guard/shell.ts`: lists,
  pipes, subshells, `$(…)`, backticks, heredocs, function and `coproc` bodies, bash 5.3 `${ …; }`) and checks every
  command it would run, through wrappers (`env`, `time`, `xargs`, `timeout`, `nice`, `bash -c`, `eval`, `find -exec`,
  `trap`, `mapfile -C`…), path prefixes and `git -C/-c` options. A script run with `bash`, `sh`, `source` or `./` is
  checked by its content, and a `package.json` script run by bun, npm, pnpm or yarn (`run <name>` or bare) by its
  body, with its `pre` and `post` scripts, from the nearest `package.json`. It refuses all of the following and tells
  the agent what to do instead:
  - `gh` beyond an allowlist: read-only `pr`, `run`, `workflow`, `issue`, `repo` and `search` commands, `gh api` GETs
    and GraphQL queries written inline, and the PR writes a fix needs (opening one as a draft, commenting, editing one
    without touching its base or reviewers). So `gh pr merge`, watching checks, re-running or cancelling runs,
    `gh workflow run`, releases, API writes and mutations are out, and so is a computed word where a flag could hide.
  - tags (`git tag` creating or deleting one however its flags are written, `mktag`, `update-ref refs/tags/*`,
    pushing tags), force pushes, deleting remote branches, and pushes anywhere but `origin` and the session's own
    `fix-bt-*` branch (or its `-N` follow-ups)
  - git commands that run another command (`rebase --exec`, `submodule foreach`, `filter-branch`, `difftool -x`,
    `bisect run`), git config judged by its value (a pager, editor, ssh command, credential helper or hooks path that
    runs something, `push.followTags`, an alias; `-c core.pager=` is fine), and `git credential`
  - kubectl, helm, argocd, kargo, gcloud, gsutil, bq and `op`, Keychain reads with `security`, `sudo`, `su` and
    `doas`, and reading a process's environment (`ps -E`, `ps eww`, `/proc/*/environ`)
  - migrations, `cast send`, network calls to `*.internal.merkl.xyz`, Slack or the daemon's own port, and `curl`/`wget`
    writes to the GitHub API
  - variables that change what a later program runs, set as a prefix, through `env`, `export` or `declare`:
    `BASH_ENV`, `ZDOTDIR`, `CDPATH`, `NODE_OPTIONS`, `BUN_OPTIONS`, `GIT_EXEC_PATH`, `LD_PRELOAD`, exported bash
    functions, Bridgetown's own, and pagers, editors, ssh and askpass commands unless they run nothing
    (`GIT_EDITOR=true`, `PAGER=cat`)
  - interactive shells, commands handed to `at`, `crontab`, `launchctl`, `systemd-run`, `tmux` or `screen`, alias
    definitions, piping into a shell, and commands named through a variable, a substitution or a glob, which it cannot
    check
- **Exec-time guard.** Every session's PATH starts with read-only shims for gh, git, kubectl, helm, argocd, kargo,
  gcloud, gsutil, bq, op, sudo, su, doas, cast, curl and wget (`daemon/src/guard/exec.ts`, put back before every turn).
  Each runs the same policy on the real, fully expanded argv through the daemon's `--guard-exec`, and refuses with
  exit 126 and the reason. That catches what the command line doesn't show: Makefile and package recipes, commands a
  program spawns (`bun x.ts`, `node -e`), a command held in a variable, the gh a git hook runs, an alias from your own
  shell config. `security` has no shim, since the Claude CLI keeps its own login with `security -i`. Every Bash call
  starts in the worktree, whatever the last one `cd`'d to.
- **Writes stay in the worktree.** Edit, Write, MultiEdit and NotebookEdit are refused outside the session's worktree.
  The path is read as the CLI reads it (trimmed, `~` expanded, relative to the worktree), then followed through every
  symlink, dangling ones included; `..` and NUL bytes are refused. Reads stay open.
- **What the guard cannot see.** A program that runs a binary by its absolute path, or with a PATH of its own, goes
  around the shims, and so does the git that git runs for a hook or credential helper (git puts its own directory
  first on its children's PATH). The exec-time guard takes the session's branch from its environment, so an
  interpreter that changes it before running git can move the push check. What has no shim (`nc`, `socat`, `security`,
  `prisma`, a read of `/proc`) is checked only on the command line, so not when a runner the guard doesn't know
  (`flock`, `ionice`, `ssh`, a quoted `parallel` string) or interpreted code runs it. Files written by Bash commands
  aren't confined. The real backstops are the missing credentials (a session has no daemon, Slack or TypeSafe token to
  use or dump) and GitHub's branch protection and `production` environment approval.
- **MCP servers.** Only `merkl` and `grafana` load from the repo's `.mcp.json`, plus Bridgetown's in-process `report`,
  `ask` and `slack_context` tools.
- **Human gates.** Merging, cutting releases, re-running approved pipelines and sending replies to teammates are always your click. GitHub's
  `production` environment approval stays with the reviewer team.
- **Slack text is untrusted.** Jev's criteria and the agent prompts fence it off as data, not instructions, and label
  each thread message `[the user]`, `[a teammate]` or `[a bot or Bridgetown]`.
- **Isolation.** Each session works in its own worktree under `monorepo/.shared/worktrees/fix-bt-*`, per the repo's
  worktree convention. Housekeeping removes it, and the branch, once the session is over (below).
- **Dry run.** `--dry-run`, `BRIDGETOWN_DRY_RUN=1` or the Settings toggle stops every Slack post.

## Storage and retention

Everything stays on your Mac:

- **The store:** `~/Library/Application Support/Bridgetown/bridgetown.db` (SQLite, moved by `BRIDGETOWN_HOME`): alerts,
  sessions with their transcripts, cards and settings. The exec-time guard's shims live beside it, in
  `guard-bin/<port>/`.
- **Schema baseline:** `008_initial` creates a fresh store in one migration. Stores already upgraded through
  version 8 keep their data and migration record; `009_agent_provider` preserves their Claude conversation IDs
  under the provider-neutral session fields. Earlier database versions are
  no longer upgraded by the daemon.
- **Worktrees:** `monorepo/.shared/worktrees/fix-bt-*`, or `<home>/worktrees/<repo>/` for a repo without `.shared/`.
- **Agent conversations:** where the Claude CLI keeps them, `~/.claude/projects/` (or under `CLAUDE_CONFIG_DIR`).
- **Logs:** `~/Library/Logs/Bridgetown/daemon.log`, the daemon's output and the app's notes about it. Past 10 MB it
  becomes `daemon.log.1`, replacing the one before, so the two stay within about 20 MB. Deleting it is fine: **Open
  logs** creates it again. A daemon that stops on its own soon after starting, twice in a row, shows as a problem with
  an **Open logs** button.

Housekeeping (`daemon/src/housekeeping/`) runs 2 minutes after the daemon starts, then every hour:

- **Worktrees.** A resolved session's worktree goes at the next round. A closed, stopped or failed session keeps its
  worktree for 24 hours, so your message can reopen it, or Retry rebuild it; what setup left of one stopped while
  preparing goes at the next round. The session's local `fix-bt-*` branch and its `-N` follow-ups go with the
  worktree, except a failed session's, which stays for Retry until the session itself goes. Branches on GitHub are
  left alone. A locked worktree is yours and stays, with its branch and whatever you changed there: **Take over in
  Terminal** runs `git worktree lock` before resuming the saved provider conversation, and `git worktree unlock` hands it back.
- **Rows.** After 30 days: alerts, finished sessions with their transcripts, and cards, unless the card's session is
  still active. Kept however old: the newest 30 alerts and the newest 20 finished sessions (what the app shows),
  anything a card still names, a session whose worktree is still there, and an active session's alerts. A session
  goes only with its alert, and its agent conversation goes with it. Codex investigations keep their isolated configuration and conversation under `<daemon home>/codex/<session id>`; Take over uses that saved directory. Unavailable Codex costs are omitted from the UI.
- **The database.** Freed pages go back to the disk (incremental auto-vacuum, switched on once for a database made
  before it), and the write-ahead log is emptied every round and shrinks back to 8 MB after any other checkpoint.
- **Review scratch.** A Codex review works in a `bt-review-*` temporary directory; one a killed daemon left behind
  goes after a day.

### Persistent memory

Memory is enabled by default and starts with new evidence after activation; it does not import previous Slack
history or stored transcripts. Disabling it in Settings stops capture, recall and background jobs, preserving the
existing notes and pending queue. Pause auto-start and dry run retain their existing meanings: memory can still
learn while agents are paused or Slack posting is suppressed, and a dry-run reply is recorded as not sent.

The daemon stores pending evidence in SQLite alongside source records when possible. Message edits, new thread
replies, accepted user messages and answers, action attempts/results/dismissals, agent findings and session outcomes
are distinct evidence. Known launch credentials and common token/private-key formats are redacted. Learning selects
durable technical context and preferences rather than saving transcript dumps. Processed evidence expires after 30
days; pending evidence stays until successfully processed. The Markdown notes and Git history have no automatic
expiry and survive normal session/worktree housekeeping.

The separate local repo is `$BRIDGETOWN_HOME/memory` (by default
`~/Library/Application Support/Bridgetown/memory`). `MEMORY.md` is the short entry point; topic files use root-relative
`[[path]]` links without `.md`. Each new fact carries its evidence ID, date, category and original source link:

```markdown
- Prefers concise summaries [source: bridgetown:event/<id>; added: 2026-10-07; evidence: user statement; origin: bridgetown:session/<id>]
```

Source categories are user statements, source statements (including Slack alerts), observed workflow, and agent
claims. An agent cannot upgrade its claim to an observed outcome. A dismissal is not proof of resolution or a
lasting preference; a draft PR is not a deployment. Original links remain in the notes after raw evidence expires.

The daemon runs one memory job at a time with your existing Claude authentication. Learning batches up to 50 events
(and 60,000 characters of evidence) once a minute; Sonnet has a $0.50/two-minute/12-turn limit. Dreaming has a
$1/five-minute/20-turn limit and runs every six hours when evidence has changed, or after a manual **Run now**.
It merges duplicates, updates stale entries, and checks retained sources for contradictions. Missing evidence is
not confirmation. Empty batches require no model call. Tests and the demo use fake adapters.

Memory jobs can only read their input wiki and supported evidence. They return proposed Markdown changes; the
daemon validates sources, links and paths, checks for concurrent edits, and commits only its own files. They cannot
run shell commands, fetch URLs, edit project files, or change approvals. Git commits record processed event IDs so a
restart between commit and database acknowledgement does not repeat the batch. Model, Git or validation failures
leave evidence pending and appear in Settings; intake and agent work continue without recalled context if memory
cannot be read. No remote is created, fetched or pushed.

Agent sessions use the Claude SDK's OS sandbox to deny shell writes to the memory folder, including commands run
by project scripts. The existing command guards and approval gates still apply. Sessions fail closed if the OS
sandbox is unavailable; agents submit new notes through `memory_remember` instead of editing the wiki.

**Correcting memory.** Use **Open memory folder**, edit the Markdown files, then commit the files you changed:

```sh
cd "$HOME/Library/Application Support/Bridgetown/memory"
git add -- preferences.md MEMORY.md
git -c user.name=Bridgetown -c user.email=memory@bridgetown.local commit -m "Correct preferences"
```

Use the actual filenames you edited and your configured `BRIDGETOWN_HOME` if different. The daemon never resets
or overwrites dirty files. It can read uncommitted corrections, but learning waits for a clean repository. To remove
a topic, also remove or update links to it. Do not rewrite Git history: its checkpoints support restart recovery.

## What gets posted as you (🤖-prefixed)

- **In the alert thread:** "Investigating with Bridgetown…" (also your claim on the alert, see above), the fix PR, a
  recommendation or "No action needed" with the agent's summary, "Review requested in #…", "Merged …", "Released vX;
  watching the deploy.", "Re-ran the failed jobs…" and "Deployed vX ✓". A Bridgetown finding has no thread, so nothing
  is posted for it.
- **In the approvals channel:** once CI is green, a review request, unless the PR is already approved. Product apps go to
  `#product-approvals` and ping `@dev-product`; everything else goes to `#general-approvals` with the owning team. The
  request includes the PR link and the Revv walkthrough deep link
  (`revv://pr?host=nocturlab.ghe.com&repo=Merkl%2Fmonorepo&number=N`).
- **In a teammate's thread:** a delegated agent's reply, only after you press **Send reply**. An inbox item's thread
  (often a DM) gets nothing else: no claim, and none of the updates above.
