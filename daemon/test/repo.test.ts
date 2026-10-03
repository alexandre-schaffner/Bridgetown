import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ActionQueue, RETRY } from "../src/actions/queue.ts"
import type { Session } from "../src/domain/model.ts"
import { recoverInterrupted, wasInterrupted } from "../src/sessions/recovery.ts"
import { SessionRepo } from "../src/sessions/repo.ts"
import { Store } from "../src/store/store.ts"
import { makeAlert, makeSession } from "./fixtures/records.ts"
import { makeWorld } from "./fixtures/world.ts"

const world = makeWorld()
afterAll(() => world.dispose())
const run = <A, E>(effect: Effect.Effect<A, E, Store | SessionRepo | ActionQueue>) => world.runPromise(effect)

const seed = (session: Session) =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* store.putAlert(makeAlert({ id: session.alertId, sessionId: session.id }))
    yield* store.putSession(session)
  })

const events = (alertId: string) =>
  Effect.gen(function* () {
    return ((yield* (yield* Store).getAlert(alertId))?.events ?? []).map((e) => e.text)
  })

describe("SessionRepo: the finished guard", () => {
  test("L1: after a stop, the runner's writes are refused and stop wins", async () => {
    const out = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepo
        yield* seed(makeSession("running", { id: "s_stop", alertId: "C1:stop" }))
        yield* repo.patch("s_stop", { status: "stopped", activity: "Stopped by you", resolution: "stopped by you" })
        const running = yield* repo.patch("s_stop", { status: "running", activity: "Resuming…" })
        const failed = yield* repo.patch("s_stop", { status: "failed", resolution: "boom" })
        const activity = yield* repo.log("s_stop", "text", "late SDK text", { activity: true }).pipe(Effect.andThen(repo.get("s_stop")))
        return { running, failed, after: activity }
      }),
    )
    expect(out.running).toBeUndefined()
    expect(out.failed).toBeUndefined()
    expect(out.after).toMatchObject({ status: "stopped", activity: "Stopped by you", resolution: "stopped by you" })
  })

  test("explicit paths may change a finished session", async () => {
    const out = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepo
        yield* seed(makeSession("failed", { id: "s_retry", alertId: "C1:retry", costUsd: 1 }))
        const cost = yield* repo.modify("s_retry", (s) => ({ ...s, costUsd: s.costUsd + 2 }), { evenIfFinished: true })
        return { cost: cost?.costUsd, retried: (yield* repo.patch("s_retry", { status: "queued" }, { evenIfFinished: true }))?.status }
      }),
    )
    expect(out).toEqual({ cost: 3, retried: "queued" })
  })

  test("a stop racing a burst of runner writes still ends stopped", async () => {
    const final = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepo
        yield* seed(makeSession("running", { id: "s_race", alertId: "C1:race" }))
        const writes = Array.from({ length: 20 }, (_, i) =>
          i === 10
            ? repo.patch("s_race", { status: "stopped" })
            : repo.modify("s_race", (s) => ({ ...s, status: "running", ciRounds: s.ciRounds + 1 })),
        )
        yield* Effect.all(writes, { concurrency: "unbounded" })
        return yield* repo.get("s_race")
      }),
    )
    expect(final?.status).toBe("stopped")
    // Writes are serialized per id: none of the increments before the stop was lost.
    expect(final?.ciRounds).toBeGreaterThanOrEqual(10)
    expect(final?.ciRounds).toBeLessThan(20)
  })

  test("concurrent modifies never lose an update", async () => {
    const final = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepo
        yield* seed(makeSession("ci", { id: "s_count", alertId: "C1:count" }))
        yield* Effect.all(
          Array.from({ length: 25 }, () => repo.modify("s_count", (s) => ({ ...s, ciRounds: s.ciRounds + 1 }))),
          { concurrency: "unbounded" },
        )
        return yield* repo.get("s_count")
      }),
    )
    expect(final?.ciRounds).toBe(25)
  })

  test("the alert's history says when its session ended and resumed", async () => {
    const texts = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepo
        yield* seed(makeSession("waiting", { id: "s_end", alertId: "C1:end", rootCauseFound: false }))
        yield* repo.patch("s_end", { status: "closed", resolution: "root cause not found" })
        yield* repo.patch("s_end", { status: "running" }, { evenIfFinished: true })
        return yield* events("C1:end")
      }),
    )
    expect(texts).toEqual(["Agent session ended · Closed · root cause not found", "Agent session resumed"])
  })
})

describe("recoverInterrupted (M5)", () => {
  const answer = (sessionId: string) => ({
    id: `a_${sessionId}`, kind: "answer" as const, title: "Which fix?", detail: "", primaryLabel: "Reply", options: [],
    sessionId, alertId: null, payload: null, url: null, createdAt: "2026-10-01T00:00:00.000Z",
  })
  test("pure rule: mid-turn, or blocked on an ask even after a first result", () => {
    expect(wasInterrupted(makeSession("running"), [])).toBe(true)
    expect(wasInterrupted(makeSession("preparing"), [])).toBe(true)
    expect(wasInterrupted(makeSession("waiting", { outcome: null }), [])).toBe(true)
    expect(wasInterrupted(makeSession("waiting", { id: "s_x", outcome: "needs_human" }), [answer("s_x")])).toBe(true)
    expect(wasInterrupted(makeSession("waiting", { id: "s_x", outcome: "needs_human" }), [])).toBe(false)
    expect(wasInterrupted(makeSession("ci"), [])).toBe(false)
  })
  test("a waiting session with a prior outcome blocked on ask fails with a retry card; answer cards go", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* Store
        const repo = yield* SessionRepo
        yield* seed(makeSession("waiting", { id: "s_ask", alertId: "C1:ask", outcome: "needs_human", pushbacks: 1 }))
        yield* seed(makeSession("waiting", { id: "s_handed", alertId: "C1:handed", outcome: "needs_human" }))
        yield* store.putAction(answer("s_ask"))
        yield* recoverInterrupted
        const actions = yield* store.listActions()
        return {
          asked: (yield* repo.get("s_ask"))?.status,
          handed: (yield* repo.get("s_handed"))?.status,
          cards: actions.filter((a) => a.sessionId === "s_ask").map((a) => [a.kind, a.payload]),
        }
      }),
    )
    expect(out).toEqual({ asked: "failed", handed: "waiting", cards: [["review", RETRY]] })
  })
})
