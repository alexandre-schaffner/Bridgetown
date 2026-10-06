import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ActionQueue } from "../src/actions/queue.ts"
import type { Action } from "../src/domain/action.ts"
import { type Session, wasInterrupted } from "../src/domain/session.ts"
import { recoverInterrupted } from "../src/sessions/recovery.ts"
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

describe("SessionRepo: a card goes once its session leaves the stage it was offered for", () => {
  const card = (sessionId: string, kind: Action["kind"], retry = false): Action => ({
    id: `a_${sessionId}_${kind}_${retry}`, kind, title: kind, detail: "", primaryLabel: "Go", options: [], sessionId,
    alertId: null, fingerprint: null, retry, url: null, createdAt: "2026-10-01T00:00:00.000Z",
  })
  const cardsAfter = (session: Session, cards: ReadonlyArray<Action>, patch: Partial<Session>) =>
    run(
      Effect.gen(function* () {
        const store = yield* Store
        yield* seed(session)
        for (const action of cards) yield* store.putAction(action)
        yield* (yield* SessionRepo).patch(session.id, patch)
        return (yield* store.listActions()).filter((a) => a.sessionId === session.id).map((a) => `${a.kind}${a.retry ? ":retry" : ""}`).sort()
      }),
    )

  test("a PR closed under a merge card leaves no merge card", async () => {
    const left = await cardsAfter(makeSession("awaiting_merge", { id: "s_closed", alertId: "C1:closed" }), [card("s_closed", "merge")], {
      status: "stopped",
      resolution: "PR closed without merging",
    })
    expect(left).toEqual([])
  })

  test("a deploy that finishes after it was handed off as stalled takes the hand-off card with it", async () => {
    const left = await cardsAfter(makeSession("waiting", { id: "s_late", alertId: "C1:late" }), [card("s_late", "review"), card("s_late", "release")], {
      status: "resolved",
    })
    expect(left).toEqual([])
  })

  test("a failed session keeps its draft reply and retry card; everything else goes", async () => {
    const left = await cardsAfter(
      makeSession("waiting", { id: "s_fail", alertId: "C1:fail" }),
      [card("s_fail", "review"), card("s_fail", "rerun"), card("s_fail", "answer"), card("s_fail", "reply"), card("s_fail", "review", true)],
      { status: "failed" },
    )
    expect(left).toEqual(["reply", "review:retry"])
  })

  test("a write that does not move the session leaves its cards alone", async () => {
    const left = await cardsAfter(makeSession("awaiting_merge", { id: "s_wait", alertId: "C1:wait" }), [card("s_wait", "merge")], {
      activity: "still waiting",
    })
    expect(left).toEqual(["merge"])
  })

  test("a session sent back to CI from the merge gate takes the Merge card with it", async () => {
    const left = await cardsAfter(makeSession("awaiting_merge", { id: "s_back", alertId: "C1:back" }), [card("s_back", "merge")], {
      status: "ci",
    })
    expect(left).toEqual([])
  })

  test("a turn starting takes the hand-off, re-run and gate cards; a reply and the turn's own answer stay", async () => {
    const left = await cardsAfter(
      makeSession("awaiting_release", { id: "s_turn", alertId: "C1:turn" }),
      [card("s_turn", "release"), card("s_turn", "review"), card("s_turn", "rerun"), card("s_turn", "reply"), card("s_turn", "answer")],
      { status: "running" },
    )
    expect(left).toEqual(["answer", "reply"])
  })
})

describe("recoverInterrupted (M5)", () => {
  const answer = (sessionId: string) => ({
    id: `a_${sessionId}`, kind: "answer" as const, title: "Which fix?", detail: "", primaryLabel: "Reply", options: [],
    sessionId, alertId: null, fingerprint: null, retry: false, url: null, createdAt: "2026-10-01T00:00:00.000Z",
  })
  test("pure rule: mid-turn, or blocked on an ask even after a first result", () => {
    expect(wasInterrupted(makeSession("running"), false)).toBe(true)
    expect(wasInterrupted(makeSession("preparing"), false)).toBe(true)
    expect(wasInterrupted(makeSession("waiting", { outcome: null }), false)).toBe(true)
    expect(wasInterrupted(makeSession("waiting", { id: "s_x", outcome: "needs_human" }), true)).toBe(true)
    expect(wasInterrupted(makeSession("waiting", { id: "s_x", outcome: "needs_human" }), false)).toBe(false)
    expect(wasInterrupted(makeSession("ci"), false)).toBe(false)
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
          cards: actions.filter((a) => a.sessionId === "s_ask").map((a) => [a.kind, a.retry]),
        }
      }),
    )
    expect(out).toEqual({ asked: "failed", handed: "waiting", cards: [["review", true]] })
  })
})
