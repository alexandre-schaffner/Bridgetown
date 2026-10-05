import { Database } from "bun:sqlite"
import { join } from "node:path"
import { scratchDir } from "./tmp.ts"

/**
 * Rows as the first daemon wrote them (copied from a real store, trimmed): no
 * `events`, `disposition`, `milestones`, `rootCauseFound`, `resolution`,
 * `pushbacks`, `mergeRequestedAt`, `releaseTag`, `deployStage`, action `url`,
 * or review `posted`, and history text where dispositions are now stored.
 */
export const OLD_ALERTS = {
  /** Release tracker alert from before alert history existed. */
  release: {
    id: "C0AUKD42N3U:1790933006.433649", channelId: "C0AUKD42N3U", channelName: "alert-releases", ts: "1790933006.433649",
    permalink: "https://merkl-adu1009.slack.com/archives/C0AUKD42N3U/p1790933006433649", title: "merkl-admin v0.6.0 · Build failed",
    summary: "Approval ✓ · Build ✗ (1 attempt failed)", raw: "Deployment merkl-admin v0.6.0", source: "releases", fingerprint: "release:merkl-admin:v0.6.0",
    fields: {
      _tag: "release", image: "merkl-admin", version: "v0.6.0", actor: "alex", runId: "291250187",
      runUrl: "https://nocturlab.ghe.com/Merkl/monorepo/actions/runs/291250187", tag: "admin-v0.6.0",
      stages: [
        { name: "Approval", status: "success", detail: "Approved by hugo" },
        { name: "Build", status: "failure", detail: "Build failed · 1 attempt failed" },
      ],
    },
    mentionsMe: false, receivedAt: "2026-10-02T09:23:26.433Z", feedback: null,
    triage: { decision: "auto", reason: "Agent-resolvable build_failure", jev: { actionable: 0.93, agentResolvable: 0.8, humanOnIt: 0.04, kind: "build_failure", kindConfidence: 1, depth: "standard", urgency: 1.8 } },
    sessionId: "s_muqvwhc25wly",
  },
  /** A suggestion you dismissed: the only record of it is the history line. */
  dismissed: {
    id: "C0AUCLN8LLB:1790986070.437059", channelId: "C0AUCLN8LLB", channelName: "alert-missing-prices", ts: "1790986070.437059",
    permalink: null, title: "Missing price for Yield.xyz Base yoEURC", summary: "Stale price", raw: "Stale price for yoEURC", source: "generic",
    fingerprint: "generic:alert-missing-prices:Missing price for Yield.xyz Base yoEURC", fields: { _tag: "generic" }, mentionsMe: false,
    receivedAt: "2026-10-03T00:07:50.437Z",
    triage: { decision: "suggest", reason: "Borderline onchain_or_keeper", jev: { actionable: 0.62, agentResolvable: 0.57, humanOnIt: 0.02, kind: "onchain_or_keeper", kindConfidence: 0.69, depth: "deep", urgency: 2.05 } },
    sessionId: null, feedback: null,
    events: [
      { at: "2026-10-03T00:07:52.529Z", text: "Suggested to you: Borderline onchain_or_keeper" },
      { at: "2026-10-03T11:16:49.567Z", text: "Dismissed by you, no agent started" },
    ],
  },
  /** An escalation you opened in Slack. */
  opened: {
    id: "C0AT6P4E9B5:1790959977.551809", channelId: "C0AT6P4E9B5", channelName: "eng-api", ts: "1790959977.551809", permalink: null,
    title: "Hugo · #eng-api: can you look at this?", summary: "", raw: "<@UME> can you look at this?", source: "inbox", fingerprint: "inbox:C0AT6P4E9B5:1790959977.551809",
    fields: { _tag: "inbox", from: "UHUGO", fromName: "Hugo", channelKind: "channel", via: "mention", threadTs: null, prUrl: null },
    mentionsMe: true, receivedAt: "2026-10-02T20:30:00.000Z",
    triage: { decision: "escalate", reason: "A decision only you can make", jev: null }, sessionId: null, feedback: "good",
    events: [{ at: "2026-10-02T20:38:56.636Z", text: "Opened by you in Slack or Revv" }],
  },
}

export const OLD_SESSIONS = {
  /** The oldest shape: no milestones, verdict or gates. */
  stopped: {
    id: "s_muqvwhc25wly", alertId: OLD_ALERTS.release.id, title: "merkl-admin v0.6.0 · Build failed", channelName: "alert-releases", status: "stopped",
    phase: "diagnose", activity: "Stopped by you", diagnosis: null, outcome: null, recommendation: null, prUrl: null, branch: "fix-bt-merkl-admin-v0-6-0-5wly",
    worktree: null, repoPath: "/Users/alex/Projects/merkl/monorepo", claudeSessionId: null, model: "claude-opus-5-5", effort: "high", ciRounds: 0, costUsd: 0,
    slackThreadUrl: null, release: null, component: "merkl-admin", review: null, startedAt: "2026-10-02T11:33:04.322Z", updatedAt: "2026-10-02T11:34:51.621Z",
  },
  /** In CI with a review request from before `posted` was stored, and none of the gate fields. */
  ci: {
    id: "s_murfld8nbdq0", alertId: "C0AUCLN8LLB:1790973549.400099", title: "Stale price for Staked BRZ (stBRZ)", channelName: "alert-missing-prices", status: "ci",
    phase: "ci", activity: "CI green — waiting for review in #product-approvals", diagnosis: "Missing price feed for stBRZ", outcome: "fix_pr", recommendation: null,
    prUrl: "https://nocturlab.ghe.com/Merkl/monorepo/pull/3371", branch: "fix-bt-stale-price-bdq0", worktree: "/tmp/does-not-exist/fix-bt-stale-price-bdq0",
    repoPath: "/tmp/does-not-exist", claudeSessionId: "b64a8b89-390b-4e0e-abd5-5460edbeb3d3", model: "claude-opus-5-5", effort: "max", ciRounds: 0, costUsd: 58.95,
    slackThreadUrl: null, release: { image: "", tag: "api", version: "" },
    milestones: { diagnosed: true, fixed: true, prOpened: true, ciGreen: false, merged: false, released: false, deployed: false },
    rootCauseFound: true, resolution: null, pushbacks: 0, component: "api",
    review: { channelName: "product-approvals", permalink: "https://merkl-adu1009.slack.com/archives/C0ATZJNRU2J/p1791047667207949", handledReviewId: null },
    startedAt: "2026-10-02T20:44:18.119Z", updatedAt: "2026-10-03T21:04:56.655Z",
  },
  /** Closed by you before `closed` existed: recorded as resolved. */
  closedAsResolved: {
    id: "s_old_closed", alertId: OLD_ALERTS.dismissed.id, title: "Missing price for Yield.xyz Base yoEURC", channelName: "alert-missing-prices", status: "resolved",
    phase: "diagnose", activity: "Closed by you", diagnosis: "Could not tell", outcome: "needs_human", recommendation: null, prUrl: null, branch: "fix-bt-x",
    worktree: null, repoPath: "/tmp/does-not-exist", claudeSessionId: null, model: "claude-opus-5-5", effort: "high", ciRounds: 0, costUsd: 1.2, slackThreadUrl: null,
    release: null, component: null, review: null, startedAt: "2026-10-02T12:00:00.000Z", updatedAt: "2026-10-02T12:30:00.000Z",
  },
}

/** A card from before `url` existed. */
export const OLD_ACTION = {
  id: "a_old_review", kind: "review", title: "CI still red · TX Executor", detail: "audit", primaryLabel: "Close session", options: [],
  sessionId: OLD_SESSIONS.ci.id, alertId: OLD_SESSIONS.ci.alertId, payload: null, createdAt: "2026-10-03T17:58:02.498Z",
}

/** A `BRIDGETOWN_HOME` holding a store exactly as the first daemon left it: its schema, its migration record, its rows. */
export const oldStore = (): string => {
  const home = scratchDir("bt-old-store-")
  const db = new Database(join(home, "bridgetown.db"))
  db.run(`CREATE TABLE "bridgetown_migrations" (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)`)
  db.run(`INSERT INTO bridgetown_migrations (migration_id, name) VALUES (1, 'initial')`)
  db.run(`CREATE TABLE alerts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, received_at TEXT NOT NULL, content_hash TEXT NOT NULL, json TEXT NOT NULL)`)
  db.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL)`)
  db.run(`CREATE TABLE actions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL)`)
  db.run(`CREATE TABLE transcript (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, json TEXT NOT NULL)`)
  db.run(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  for (const alert of Object.values(OLD_ALERTS)) {
    db.query("INSERT INTO alerts VALUES (?, ?, ?, 'h', ?)").run(alert.id, alert.fingerprint, alert.receivedAt, JSON.stringify(alert))
  }
  for (const session of Object.values(OLD_SESSIONS)) {
    db.query("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(session.id, session.status, session.updatedAt, JSON.stringify(session))
  }
  db.query("INSERT INTO actions VALUES (?, ?, ?)").run(OLD_ACTION.id, OLD_ACTION.createdAt, JSON.stringify(OLD_ACTION))
  db.query("INSERT INTO transcript (session_id, json) VALUES (?, ?)").run(OLD_SESSIONS.ci.id, JSON.stringify({ at: "2026-10-03T21:00:00.000Z", kind: "status", text: "Opened #3371" }))
  db.close()
  return home
}
