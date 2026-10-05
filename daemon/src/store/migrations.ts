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

/** Rewrites the rows of `table` that `f` changes. */
const rewrite = (table: "alerts" | "sessions", f: (row: Json) => Json | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly id: string; readonly json: string }>`SELECT id, json FROM ${sql(table)}`
    for (const row of rows) {
      const before = parse(row.json)
      const after = before === undefined ? undefined : f(before)
      if (after === undefined) continue
      if (table === "sessions") yield* sql`UPDATE sessions SET json = ${JSON.stringify(after)}, status = ${String(after.status)} WHERE id = ${row.id}`
      else yield* sql`UPDATE alerts SET json = ${JSON.stringify(after)} WHERE id = ${row.id}`
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
})
