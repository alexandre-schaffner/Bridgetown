import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { Effect } from "effect"
import { Store } from "../src/store/store.ts"
import { oldStore } from "./fixtures/old-store.ts"
import { makeAlert, makeSession } from "./fixtures/records.ts"
import { scratchDir } from "./fixtures/tmp.ts"
import { makeWorld } from "./fixtures/world.ts"

const home = scratchDir("bt-prune-")
const world = makeWorld({ home })
afterAll(() => world.dispose())

const pragma = (dir: string, name: string): unknown => {
  const db = new Database(join(dir, "bridgetown.db"), { readonly: true })
  try {
    return Object.values(db.query(`PRAGMA ${name}`).get() ?? {})[0]
  } finally {
    db.close()
  }
}

describe("store pruning", () => {
  test("sessions go with their transcripts, an active one never, an alert only once no session started from it", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        for (const [id, status] of [["s_done", "resolved"], ["s_live", "ci"], ["s_kept", "closed"]] as const) {
          yield* store.putAlert(makeAlert({ id: `a_${id}`, sessionId: id }))
          yield* store.putSession(makeSession(status, { id, alertId: `a_${id}` }))
          yield* store.appendTranscript(id, { at: "", kind: "status", text: id })
        }
        yield* store.appendTranscript("s_orphan", { at: "", kind: "status", text: "left behind" })
        yield* store.pruneRows({ actionIds: [], sessionIds: ["s_done", "s_live"], alertIds: ["a_s_done", "a_s_live", "a_s_kept"] })
        return {
          sessions: yield* Effect.forEach(["s_done", "s_live", "s_kept"], (id) => store.getSession(id).pipe(Effect.map((s) => s?.id ?? null))),
          alerts: yield* Effect.forEach(["a_s_done", "a_s_live", "a_s_kept"], (id) => store.getAlert(id).pipe(Effect.map((a) => a?.id ?? null))),
          transcripts: yield* Effect.forEach(["s_done", "s_live", "s_kept", "s_orphan"], (id) => store.transcript(id, 10).pipe(Effect.map((t) => t.length))),
        }
      }),
    )
    expect(out).toEqual({
      sessions: [null, "s_live", "s_kept"],
      alerts: [null, "a_s_live", "a_s_kept"],
      transcripts: [0, 1, 1, 0],
    })
  })

  test("maintain gives the freed pages back", async () => {
    const run = <A>(effect: Effect.Effect<A, unknown, Store>) => world.runPromise(effect)
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        for (let i = 0; i < 200; i++) yield* store.putAlert(makeAlert({ id: `a_bulk${i}`, raw: "x".repeat(4_000) }))
        yield* store.pruneRows({ actionIds: [], sessionIds: [], alertIds: Array.from({ length: 200 }, (_, i) => `a_bulk${i}`) })
      }),
    )
    expect(pragma(home, "freelist_count")).toBeGreaterThan(100)
    await run(Store.use((store) => store.maintain()))
    expect(pragma(home, "freelist_count")).toBe(0)
  })

  test("a fresh store is incrementally vacuumed", () => {
    expect(pragma(home, "auto_vacuum")).toBe(2)
  })

  test("so is a store an older daemon made without it, with its rows intact", async () => {
    const old = oldStore()
    expect(pragma(old, "auto_vacuum")).toBe(0)
    const reopened = makeWorld({ home: old })
    try {
      const sessions = await reopened.runPromise(Store.use((store) => store.recentSessions(10)))
      expect(sessions.length).toBeGreaterThan(0)
    } finally {
      await reopened.dispose()
    }
    expect(pragma(old, "auto_vacuum")).toBe(2)
  })
})
