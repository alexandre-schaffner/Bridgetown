import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { claudeProjectDir } from "../../src/agent/agent.ts"
import { acceptsMessages, type Session } from "../../src/domain/session.ts"
import { Housekeeping } from "../../src/housekeeping/housekeeping.ts"
import { ROWS_MS } from "../../src/housekeeping/retention.ts"
import { Hub } from "../../src/hub.ts"
import { SessionRunner } from "../../src/sessions/runner.ts"
import { Worktrees } from "../../src/sessions/worktree.ts"
import { Store } from "../../src/store/store.ts"
import { makeAlert, makeSession } from "../support/records.ts"
import { scratchRepo, sh } from "../support/repo.ts"
import { scratchDir } from "../support/tmp.ts"
import { makeWorld } from "../support/world.ts"

const claudeConfigDir = scratchDir("bt-claude-")
const repo = scratchRepo()
const world = makeWorld({ env: { claudeConfigDir } })
afterAll(() => world.dispose())

const HOUR = 60 * 60_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const branches = () => sh("git for-each-ref '--format=%(refname:short)' refs/heads/", repo).split("\n")
/** Where the agent of the session on `branch` keeps its conversation. */
const conversationOf = (branch: string) => run(Worktrees.use((w) => Effect.sync(() => claudeProjectDir(claudeConfigDir, w.path(repo, branch)))))

type Services = Store | Worktrees | Housekeeping | SessionRunner | Hub
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => world.runPromise(effect)

/** A session on `fix-bt-<name>` in the scratch repo, with its worktree created unless `worktree` is null. */
const seed = (name: string, status: Session["status"], updatedAt: string, overrides: Partial<Session> = {}) =>
  run(
    Effect.gen(function* () {
      const store = yield* Store
      const branch = `fix-bt-${name}`
      const { path } = yield* (yield* Worktrees).create(repo, branch)
      const session = makeSession(status, {
        id: `s_${name}`, alertId: `C1:${name}`, branch, repoPath: repo, worktree: path, claudeSessionId: "c", updatedAt, ...overrides,
      })
      yield* store.putAlert(makeAlert({ id: session.alertId, sessionId: session.id, receivedAt: updatedAt }))
      yield* store.putSession(session)
      return { path, branch, id: session.id }
    }),
  )

const housekeep = () => run(Housekeeping.use((h) => h.run))
const sessionOf = (id: string) => run(Store.use((store) => store.getSession(id)))

describe("worktrees past their session's grace", () => {
  test("a resolved session's worktree and branch go at the next round; its row only loses the path", async () => {
    const updatedAt = ago(HOUR)
    const { path, branch, id } = await seed("resolved", "resolved", updatedAt)
    await housekeep()
    expect(existsSync(path)).toBe(false)
    expect(branches()).not.toContain(branch)
    expect(await sessionOf(id)).toMatchObject({ worktree: null, updatedAt })
  })

  test("a closed session keeps its worktree for a day, so your message can still reopen it", async () => {
    const fresh = await seed("closed-fresh", "closed", ago(23 * HOUR))
    const stale = await seed("closed-stale", "closed", ago(25 * HOUR))
    await housekeep()
    const [kept, gone] = [await sessionOf(fresh.id), await sessionOf(stale.id)]
    expect(existsSync(fresh.path)).toBe(true)
    expect(kept !== undefined && acceptsMessages(kept)).toBe(true)
    expect(existsSync(stale.path)).toBe(false)
    expect(gone !== undefined && acceptsMessages(gone)).toBe(false)
  })

  test("a failed session's worktree goes after a day but its branch stays, so Retry rebuilds the same worktree", async () => {
    const { path, branch } = await seed("failed", "failed", ago(25 * HOUR))
    await housekeep()
    expect(existsSync(path)).toBe(false)
    expect(branches()).toContain(branch)
    expect((await run(Worktrees.use((w) => w.create(repo, branch)))).path).toBe(path)
  })

  test("a session cut off while preparing never recorded its worktree: found by its branch, kept only while Retry can use it", async () => {
    const stopped = await seed("stopped-setup", "stopped", ago(0), { worktree: null })
    const fresh = await seed("interrupted-fresh", "failed", ago(23 * HOUR), { worktree: null })
    const stale = await seed("interrupted-stale", "failed", ago(25 * HOUR), { worktree: null })
    await housekeep()
    expect(existsSync(stopped.path)).toBe(false)
    expect(branches()).not.toContain(stopped.branch)
    expect(existsSync(fresh.path)).toBe(true)
    expect(existsSync(stale.path)).toBe(false)
    expect(branches()).toContain(stale.branch)
  })

  test("an active session, and a finished one with a turn waiting for a slot, keep theirs", async () => {
    const active = await seed("active", "ci", ago(40 * 24 * HOUR))
    const parked = await seed("parked", "closed", ago(25 * HOUR))
    await run(
      Effect.gen(function* () {
        const hub = yield* Hub
        yield* hub.updateSettings({ ...(yield* hub.settings), maxConcurrent: 0 })
        yield* (yield* SessionRunner).message(parked.id, "one more thing")
      }),
    )
    expect(await run(SessionRunner.use((runner) => runner.busy(parked.id)))).toBe(true)
    await housekeep()
    expect(existsSync(active.path)).toBe(true)
    expect(existsSync(parked.path)).toBe(true)
  })
})

describe("rows past retention", () => {
  test("a month later a session's row, transcript and alert go, with its branch and the agent's conversation", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        // Newer than the old one, so the snapshot's floors (30 alerts, 20 finished sessions) don't keep it.
        for (let i = 0; i < 30; i++) {
          yield* store.putAlert(makeAlert({ id: `C1:filler${i}`, receivedAt: ago(HOUR), sessionId: i < 20 ? `s_filler${i}` : null }))
          if (i < 20) yield* store.putSession(makeSession("closed", { id: `s_filler${i}`, alertId: `C1:filler${i}`, branch: null, worktree: null, updatedAt: ago(HOUR) }))
        }
      }),
    )
    const old = await seed("old", "failed", ago(ROWS_MS + HOUR), { worktree: null })
    const recent = await seed("recent", "resolved", ago(HOUR))
    for (const { branch } of [old, recent]) {
      const conversation = await conversationOf(branch)
      mkdirSync(conversation, { recursive: true })
      writeFileSync(join(conversation, "c.jsonl"), "{}")
    }
    await run(Store.use((store) => store.appendTranscript(old.id, { at: ago(ROWS_MS), kind: "status", text: "Session started" })))
    await housekeep()
    const left = await run(
      Effect.gen(function* () {
        const store = yield* Store
        return { session: yield* store.getSession(old.id), alert: yield* store.getAlert("C1:old"), transcript: yield* store.transcript(old.id, 10) }
      }),
    )
    expect(left).toEqual({ session: undefined, alert: undefined, transcript: [] })
    expect(existsSync(old.path)).toBe(false)
    expect(branches()).not.toContain(old.branch)
    expect(existsSync(await conversationOf(old.branch))).toBe(false)
    // A session that is merely finished keeps its conversation until its row goes.
    expect(existsSync(await conversationOf(recent.branch))).toBe(true)
  })
})
