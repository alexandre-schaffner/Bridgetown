import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"

/** Current schema baseline. Keep version 8 so existing stores and future migrations share the same sequence. */
export const migrations = SqliteMigrator.fromRecord({
  "008_initial": Effect.gen(function* () {
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
  "009_memory": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE memory_evidence (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, json TEXT NOT NULL, at TEXT NOT NULL, processed_at TEXT)`
    yield* sql`CREATE INDEX memory_pending ON memory_evidence (processed_at, seq)`
    yield* sql`INSERT OR IGNORE INTO kv (key, value) VALUES ('memory_activated_at', ${new Date().toISOString()})`
  }),
})
