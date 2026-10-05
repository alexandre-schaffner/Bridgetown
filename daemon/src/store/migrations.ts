import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * The schema, and one-time rewrites of rows an older daemon wrote. Rows are JSON
 * documents: a field added later decodes with a default (`nullByDefault` in
 * model.ts), so a migration is only needed when the right value has to be read
 * from something else the old row kept. Those run over every row, once.
 */

/** A stored row as plain JSON: older shapes are read field by field, never through today's schema. */
type Json = { readonly [key: string]: unknown }

const parse = (text: string): Json | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
  } catch {
    return undefined
  }
}

const eventsOf = (row: Json): ReadonlyArray<{ readonly at: string; readonly text: string }> =>
  Array.isArray(row.events)
    ? row.events.flatMap((event: unknown) => {
        if (typeof event !== "object" || event === null) return []
        const { at, text } = Object.fromEntries(Object.entries(event))
        return typeof at === "string" && typeof text === "string" ? [{ at, text }] : []
      })
    : []

/**
 * Before dispositions were stored, what you did to an alert's card was only in
 * its history text. The last such line is the disposition; `undefined` when the
 * row already has one or there is nothing to read.
 */
export const legacyDisposition = (alert: Json): Json | undefined => {
  if (alert.disposition !== undefined && alert.disposition !== null) return undefined
  const last = eventsOf(alert).findLast((e) => e.text.startsWith("Dismissed by you") || e.text.startsWith("Opened by you"))
  if (last === undefined) return undefined
  return { ...alert, disposition: { kind: last.text.startsWith("Opened by you") ? "opened" : "dismissed", at: last.at } }
}

/**
 * Before `closed` existed, closing an unfinished session recorded it as
 * resolved ("Closed by you"). It is closed, with the honest resolution;
 * `undefined` for every other row.
 */
export const legacyClosed = (session: Json): Json | undefined => {
  if (session.status !== "resolved" || session.activity !== "Closed by you") return undefined
  return {
    ...session,
    status: "closed",
    resolution: session.outcome === "recommendation" ? "recommendation handed to you" : "root cause not found",
    rootCauseFound: typeof session.rootCauseFound === "boolean" ? session.rootCauseFound : session.outcome === "fix_pr" ? null : false,
  }
}

/**
 * Before `posted` was stored, a review request had a permalink only when it
 * reached Slack. Without this the default (`false`) would post it a second time.
 */
export const legacyReviewPosted = (session: Json): Json | undefined => {
  const review = session.review
  if (typeof review !== "object" || review === null || "posted" in review) return undefined
  const fields = Object.fromEntries(Object.entries(review))
  return { ...session, review: { ...fields, posted: typeof fields.permalink === "string" } }
}

/**
 * Before `releasePrefix`, `release.tag` held the prefix the agent named until its release was cut, and the tag cut
 * (or the one a re-run followed) after; `component` held that prefix again, or the alert's image. The prefix goes to
 * `releasePrefix` and a tag to `releaseTag`; `release` and `component` go. `undefined` for a row already rewritten.
 */
export const legacyRelease = (session: Json): Json | undefined => {
  if (!("release" in session) && !("component" in session)) return undefined
  const { release, component: _component, ...rest } = session
  const fields = typeof release === "object" && release !== null ? Object.fromEntries(Object.entries(release)) : {}
  const tag = typeof fields.tag === "string" ? fields.tag.trim() : ""
  const recorded = typeof session.releaseTag === "string" ? session.releaseTag : null
  const milestones = typeof session.milestones === "object" && session.milestones !== null ? Object.fromEntries(Object.entries(session.milestones)) : {}
  const prefix = tag.replace(/-v\d+\.\d+\.\d+.*$/, "")
  if (tag === "") return { ...rest, releasePrefix: null, releaseTag: recorded }
  // Cut: the prefix it was cut under, and the tag.
  if (milestones.released === true) return { ...rest, releasePrefix: prefix, releaseTag: recorded ?? tag }
  // Without a PR of its own, only a re-run set it: the tag that re-run follows.
  if (typeof session.prUrl !== "string") return { ...rest, releasePrefix: null, releaseTag: recorded ?? tag }
  return { ...rest, releasePrefix: prefix, releaseTag: recorded }
}

/**
 * Before a session kept the version of its tracker it took in, `tracker` was the alert id alone. The version stored
 * then counts as taken in, so nothing is applied twice; `hashOf` reads it. `undefined` for every other row.
 */
export const legacyTracker = (session: Json, hashOf: (alertId: string) => string | undefined): Json | undefined =>
  typeof session.tracker === "string" ? { ...session, tracker: { id: session.tracker, applied: hashOf(session.tracker) ?? null } } : undefined

/**
 * Before cards had typed fields, `payload` was one string read six ways by kind. An investigate or escalate card's was
 * its alert's fingerprint and a retry card's was "retry"; the rest (a tag, a PR, a run, a draft) are read from the
 * session, its alert or the card's own detail now. `undefined` for a card already rewritten.
 */
export const legacyPayload = (action: Json): Json | undefined => {
  if (!("payload" in action)) return undefined
  const { payload, ...rest } = action
  const kind = action.kind
  return {
    ...rest,
    fingerprint: (kind === "investigate" || kind === "escalate") && typeof payload === "string" ? payload : null,
    retry: kind === "review" && payload === "retry",
  }
}

/** Rewrites the rows of `table` that `f` changes. */
const rewrite = (table: "alerts" | "sessions" | "actions", f: (row: Json) => Json | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly id: string; readonly json: string }>`SELECT id, json FROM ${sql(table)}`
    for (const row of rows) {
      const before = parse(row.json)
      const after = before === undefined ? undefined : f(before)
      if (after === undefined) continue
      if (table === "sessions") yield* sql`UPDATE sessions SET json = ${JSON.stringify(after)}, status = ${String(after.status)} WHERE id = ${row.id}`
      else yield* sql`UPDATE ${sql(table)} SET json = ${JSON.stringify(after)} WHERE id = ${row.id}`
    }
  })

export const migrations = SqliteMigrator.fromRecord({
  "001_initial": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE alerts (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        received_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        json TEXT NOT NULL
      )
    `
    yield* sql`CREATE INDEX alerts_fingerprint ON alerts (fingerprint, received_at)`
    yield* sql`CREATE INDEX alerts_received ON alerts (received_at)`
    yield* sql`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL
      )
    `
    yield* sql`
      CREATE TABLE actions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL
      )
    `
    yield* sql`
      CREATE TABLE transcript (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        json TEXT NOT NULL
      )
    `
    yield* sql`CREATE INDEX transcript_session ON transcript (session_id, seq)`
    yield* sql`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  }),
  "002_dispositions": rewrite("alerts", legacyDisposition),
  "003_closed_sessions": rewrite("sessions", legacyClosed),
  "004_review_posted": rewrite("sessions", legacyReviewPosted),
  // One poll horizon for every channel, from before each channel kept its own (`since:<channel id>`): nothing reads it.
  "005_global_horizon": SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql`DELETE FROM kv WHERE key = 'since'`)),
  "006_release_prefix": rewrite("sessions", legacyRelease),
  "007_tracker_version": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const hashes = new Map((yield* sql<{ readonly id: string; readonly hash: string }>`SELECT id, content_hash AS hash FROM alerts`).map((row) => [row.id, row.hash]))
    yield* rewrite("sessions", (session) => legacyTracker(session, (id) => hashes.get(id)))
  }),
  "008_action_fields": rewrite("actions", legacyPayload),
})
