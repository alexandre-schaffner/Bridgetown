import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { migrations } from "../../src/store/migrations.ts"
import { Store } from "../../src/store/store.ts"
import { makeAlert, makeSession } from "../support/records.ts"
import { scratchDir } from "../support/tmp.ts"
import { makeWorld } from "../support/world.ts"

const alert = makeAlert({ id: "a_saved", sessionId: "s_saved", disposition: { kind: "dismissed", at: "2026-10-07T10:00:00Z" } })
const session = makeSession("closed", { id: "s_saved", alertId: alert.id, releasePrefix: "api", releaseTag: "api-v1.2.3", tracker: { id: alert.id, applied: "hash" } })
const action = {
  id: "a_investigate", kind: "investigate", title: "Investigate", detail: "", primaryLabel: "Investigate", options: [],
  sessionId: null, alertId: alert.id, fingerprint: alert.fingerprint, retry: false, url: null, createdAt: "2026-10-07T10:00:00Z",
} as const
const entry = { at: "2026-10-07T10:00:00Z", kind: "status", text: "Closed without a fix" } as const

const seed = async (home: string) => {
  const world = makeWorld({ home })
  try {
    await world.runPromise(
      Store.use((store) => Effect.gen(function* () {
        yield* store.putAlert(alert, "hash")
        yield* store.putSession(session)
        yield* store.putAction(action)
        yield* store.appendTranscript(session.id, entry)
        yield* store.setKv("since:C1", "123")
      })),
    )
  } finally {
    await world.dispose()
  }
}

const reopen = async (home: string) => {
  const world = makeWorld({ home })
  try {
    return await world.runPromise(
      Store.use((store) => Effect.gen(function* () {
        return {
          alert: yield* store.getAlert(alert.id),
          hash: yield* store.alertHash(alert.id),
          session: yield* store.getSession(session.id),
          actions: yield* store.listActions(),
          transcript: yield* store.transcript(session.id, 10),
          cursor: yield* store.getKv("since:C1"),
        }
      })),
    )
  } finally {
    await world.dispose()
  }
}

const saved = { alert, hash: "hash", session, actions: [action], transcript: [entry], cursor: "123" }

describe("the squashed schema baseline", () => {
  test("a fresh store records the baseline and memory migration and creates every table and index", async () => {
    const home = scratchDir("bt-baseline-")
    await seed(home)
    const db = new Database(join(home, "bridgetown.db"), { readonly: true })
    try {
      expect(db.query("SELECT migration_id, name FROM bridgetown_migrations").all()).toEqual([{ migration_id: 8, name: "initial" }, { migration_id: 9, name: "memory" }])
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual(
        ["actions", "alerts", "bridgetown_migrations", "kv", "memory_evidence", "sessions", "transcript"].map((name) => ({ name })),
      )
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual(
        ["alerts_fingerprint", "alerts_received", "memory_pending", "transcript_session"].map((name) => ({ name })),
      )
    } finally {
      db.close()
    }
    expect(await reopen(home)).toEqual(saved)
    expect(await reopen(home)).toEqual(saved)
  })

  test("a store already at version 8 keeps its data and can apply the next migration", async () => {
    const home = scratchDir("bt-existing-baseline-")
    await seed(home)
    const db = new Database(join(home, "bridgetown.db"))
    try {
      // The last migration's original name: the migrator must skip the baseline by version.
      db.run("UPDATE bridgetown_migrations SET name = 'action_fields' WHERE migration_id = 8")
      // Simulate a pre-memory installation, with all original rows still present.
      db.run("DROP TABLE memory_evidence")
      db.run("DELETE FROM bridgetown_migrations WHERE migration_id = 9")
      db.run("DELETE FROM kv WHERE key = 'memory_activated_at'")
    } finally {
      db.close()
    }
    expect(await reopen(home)).toEqual(saved)
    const applied = await Effect.runPromise(
      SqliteMigrator.run({
        table: "bridgetown_migrations",
        loader: Effect.all([
          migrations,
          SqliteMigrator.fromRecord({
            "010_next": SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql`INSERT INTO kv (key, value) VALUES ('next', 'applied')`)),
          }),
        ]).pipe(Effect.map((groups) => groups.flat())),
      }).pipe(Effect.provide(SqliteClient.layer({ filename: join(home, "bridgetown.db") })), Effect.scoped),
    )
    expect(applied).toEqual([[10, "next"]])
    expect(await reopen(home)).toEqual(saved)
    const updated = new Database(join(home, "bridgetown.db"), { readonly: true })
    try {
      expect(updated.query("SELECT value FROM kv WHERE key = 'next'").get()).toEqual({ value: "applied" })
    } finally {
      updated.close()
    }
  })
})
