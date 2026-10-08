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
- **A reviewer checks every fix.** Agents open PRs as drafts. Before a pushed fix goes to CI, the selected model reviews the diff adversarially without write tools (`daemon/src/critique/`). Both providers get only scoped commit-file reads, with no shell, direct network access or subagents. The same provider may investigate and review. Jev
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

Sessions are headless. Their authority comes from typed broker capabilities, not instructions found in alerts or repository files.

- **Trusted inference clients.** Claude and Codex authenticate on the host. Built-in shell, file, web, subagent and arbitrary MCP tools are refused; only Bridgetown’s broker tools are authorized. User/repository settings are excluded. Codex must load the required synchronous hook or the turn stops. The provider CLI and its hooks remain trusted software, not an OS-isolated inference process.
- **OS sandbox for generated code and file operations.** Every local command, source read, source write and publication snapshot uses a separate macOS Seatbelt sandbox via the pinned sandbox runtime. It permits the worktree, per-command scratch and required system runtime reads, denies network access (including direct loopback and arbitrary Unix sockets), and blocks Keychain IPC and shared-memory IPC. Protected credentials, Git metadata, agent settings and CI workflow writes are denied. Absolute binary paths and interpreted code inherit the same restrictions. Unsupported platforms or launch failures refuse the operation; there is no unrestricted fallback. Source-mode file/policy helpers additionally read the trusted daemon package to resolve dependencies; generated commands never get this grant.
- **Credential separation.** Generated processes receive an explicit minimal environment and scratch HOME. Provider authentication is passed only to the inference client. Git authentication belongs to trusted host utilities; Slack, TypeSafe and daemon API tokens are not inherited. The app supplies daemon secrets over stdin. Known token/private-key patterns are redacted from evidence/transcripts or rejected before publication; this is heuristic detection, not complete data-loss prevention.
- **Brokered network capabilities.** `bt_github` reads selected PR/run/issue/history information from `nocturlab.ghe.com/Merkl/monorepo`. `bt_observe` calls only the two approved Grafana read operations at `127.0.0.1:8000/mcp`: Prometheus range queries and a fixed VictoriaLogs GET endpoint. Reads span at most three hours within three hours of the investigation’s start, with at most 100 log rows. Tools have strict argument schemas, output budgets and cancellation/time limits. Repository `.mcp.json`, direct Merkl MCP access, endpoint probes, arbitrary API calls and arbitrary tool selection are unavailable.
- **Immutable fix publication.** `bt_submit_fix` verifies the trusted worktree registration and session branch, refuses protected changes and captures bounded UTF-8 regular files under the OS sandbox. Changed-file discovery compares raw working bytes to immutable tree entries inside the sandbox, without host clean filters; existing protected credential entries are preserved without reading their contents. It scans those exact bytes, writes Git objects without filters, builds a separate index, commits with an expected-parent comparison, and pushes that exact object ID to the fixed HTTPS repository and session ref. Mutable files are never passed to `git add`. Existing PRs return to draft before their head moves; new PRs are drafts. The broker prepares follow-up branches from main after merged fixes. Binary/oversized changes and protected configuration edits require a human.
- **Read-only review.** Both providers receive the same bounded diff tied to the pushed commit and only `bt_read_file` / `bt_list_files` afterward, reading immutable Git objects at that exact commit rather than mutable working files. Reviewers have no shell, network, Slack, write or publication capability. Built-in tools and arbitrary MCP calls are denied.
- **Untrusted evidence.** Slack messages, alerts, repository reads, diffs and tool results are labelled as data and fenced against delimiter breakout. This helps the model identify instructions but cannot guarantee prompt-injection resistance. Broker capabilities limit what a manipulated model can do. Scoped source and operational evidence still reach the chosen model provider, and permitted fixes can still contain sensitive business data that does not match a secret pattern.
- **Human gates.** Merges, releases, approved pipeline re-runs and teammate replies require your click. A merge rechecks current checks, draft state and review before using GitHub’s expected-head condition; a recorded independent review must match that head when model reviewing is enabled. GitHub branch protections and production environment approval remain external backstops.
- **Operational limits.** Each command has a five-minute timeout and a combined 64 KiB output budget. Ordinary child process groups are killed on completion, timeout and cancellation. A process that deliberately creates a new session can outlive the command while retaining its OS restrictions and continue modifying the worktree. Immutable publication prevents those later writes from entering a scanned fix. This is not VM isolation or a complete CPU/memory/fork-bomb boundary; use a disposable VM for hostile code needing stronger lifecycle isolation.
- **Dependency bootstrap.** Initial checkout and follow-up branch switching disable every configured Git clean, smudge and process driver, along with hooks and fsmonitor. Working files use raw committed bytes; repositories requiring Git LFS or other transformations need human preparation. The trusted preparation step uses `bun install --ignore-scripts`, without provider credentials. Downloads still run on the host and use trusted package-manager configuration. Lifecycle scripts must be inspected and run explicitly within the sandbox; commands needing downloads or local servers require a human.
- **Dry run.** `--dry-run`, `BRIDGETOWN_DRY_RUN=1` or the Settings toggle stops Slack posts. It does not prevent draft PR publication.

## Storage and retention

Everything stays on your Mac:

- **The store:** `~/Library/Application Support/Bridgetown/bridgetown.db` (SQLite, moved by `BRIDGETOWN_HOME`): alerts,
  sessions with their transcripts, cards and settings. Isolated Codex configuration and conversation state live under `codex/<session>/`.
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
Index bullets use bare links such as `- [[operations/alerts]]`. Labeled links under an Index heading are normalized
to bare links, discarding descriptions; facts belong in topic files and still require source metadata.

The daemon runs one memory job at a time with the provider, model and effort chosen in **Settings → Models → Memory**.
Automatic uses Claude Sonnet with medium effort. Jobs use the selected provider's existing authentication.
Learning batches up to 50 events (and 60,000 characters of evidence) once a minute, with a two-minute timeout.
Dreaming has a five-minute timeout and runs every six hours when evidence has changed, or after a manual **Run now**.
Claude limits spending to $0.50 for learning and $1 for dreaming; Codex does not report spending. Each Claude
attempt allows at most 12 learning turns or 20 consolidation turns.
It merges duplicates, updates stale entries, and checks retained sources for contradictions. Missing evidence is
not confirmation. Empty batches require no model call. Tests and the demo use fake adapters.

Memory jobs can only read their input wiki and supported evidence. They return proposed Markdown changes; the
daemon validates sources, links and paths, checks for concurrent edits, and commits only its own files. They cannot
run shell commands, fetch URLs, edit project files, or change approvals. Git commits record processed event IDs so a
restart between commit and database acknowledgement does not repeat the batch. Model, Git or validation failures
leave evidence pending and appear in Settings; intake and agent work continue without recalled context if memory
cannot be read. No remote is created, fetched or pushed.
Invalid proposals receive the validation error and may be corrected twice against the same original snapshot.
All attempts share the job's timeout and remaining Claude spending budget. Nothing is written or acknowledged
until a complete proposal passes validation; API/authentication errors and concurrent edits stop the job immediately.

Both providers use broker tools for memory search and topic reads; results are bounded, redacted and fenced as
untrusted evidence. Generated commands and file operations run in the macOS sandbox described above, which
denies access to the daemon-owned memory folder outside the session worktree, including through symlinks.
Agents submit attributed claims through `memory_remember`; they cannot edit the wiki or override approvals.

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
