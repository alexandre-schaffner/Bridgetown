import { afterAll, describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { Actions } from "../src/actions/actions.ts"
import { DRY_RUN_REPLY } from "../src/actions/handlers.ts"
import type { Action } from "../src/domain/action.ts"
import type { Alert } from "../src/domain/alert.ts"
import { holdsSlot, NO_MILESTONES, type Session } from "../src/domain/session.ts"
import { Hub } from "../src/hub.ts"
import { AlertPipeline } from "../src/pipeline/alerts.ts"
import { Intake } from "../src/pipeline/intake.ts"
import { SessionRunner } from "../src/sessions/runner.ts"
import { Shipper } from "../src/ship/shipper.ts"
import { MAX_CI_ROUNDS } from "../src/ship/transitions.ts"
import { Store } from "../src/store/store.ts"
import { makeAlert, makeSession } from "./support/records.ts"
import { fakeJev, fakeSlack, postedIn, verdict } from "./support/fakes.ts"
import { makeWorld } from "./support/world.ts"

const card = (overrides: Partial<Action>): Action => ({
  id: "a_x", kind: "review", title: "t", detail: "", primaryLabel: "Close session", options: [], sessionId: null, alertId: null,
  fingerprint: null, retry: false, url: null, createdAt: "2026-10-01T00:00:00.000Z", ...overrides,
})

const seed = (session: Session, alert: Partial<Alert> = {}) =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* store.putAlert(makeAlert({ id: session.alertId, sessionId: session.id, ...alert }))
    yield* store.putSession(session)
  })

describe("deliver respects status and maxConcurrent (M6, L2)", () => {
  const world = makeWorld()
  afterAll(() => world.dispose())

  test("L2: an agent blocked on ask holds its slot", () => {
    expect(holdsSlot(makeSession("waiting", { id: "s1" }), new Set(["s1"]))).toBe(true)
    expect(holdsSlot(makeSession("waiting", { id: "s1" }), new Set())).toBe(false)
    expect(holdsSlot(makeSession("preparing"), new Set())).toBe(true)
  })

  test("no turn in a removed worktree, none on a stopped session, parked when slots are full", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const runner = yield* SessionRunner
        const hub = yield* Hub
        yield* hub.updateSettings({ ...(yield* hub.settings), maxConcurrent: 1 })
        const handedBack = { worktree: "/w", claudeSessionId: "c", prUrl: "https://ghe/pull/1" }
        yield* seed(makeSession("running", { id: "s_busy", alertId: "C1:busy", ...handedBack }))
        yield* seed(makeSession("resolved", { id: "s_done", alertId: "C1:done", ...handedBack, worktree: null }))
        yield* seed(makeSession("stopped", { id: "s_stopped", alertId: "C1:stopped", ...handedBack }))
        yield* seed(makeSession("ci", { id: "s_ci", alertId: "C1:ci", ...handedBack }))
        const removed = yield* runner.continueWith("s_done", "CI red")
        const stopped = yield* runner.continueWith("s_stopped", "CI red")
        const parked = yield* runner.continueWith("s_ci", "CI red", { ciRounds: 1 })
        const again = yield* runner.continueWith("s_ci", "and a follow-up")
        const busy = yield* runner.busy("s_ci")
        yield* runner.stop("s_ci")
        return { removed, stopped, parked, again, busy, afterStop: yield* runner.busy("s_ci"), ci: (yield* (yield* Store).getSession("s_ci"))?.status }
      }),
    )
    expect(out).toEqual({ removed: "refused", stopped: "refused", parked: "parked", again: "parked", busy: true, afterStop: false, ci: "stopped" })
  })
})

describe("cards (L3, L4)", () => {
  const dry = makeWorld()
  const live = makeWorld({ env: { forceDryRun: false } })
  afterAll(async () => {
    await dry.dispose()
    await live.dispose()
  })
  const inbox = { source: "inbox" as const, fields: { _tag: "inbox" as const, from: "U2", fromName: "Pierre", channelKind: "channel" as const, via: "mention" as const, threadTs: null, prUrl: null } }

  test("L3: dismissing a merge card records the session closed, not fixed", async () => {
    const session = await dry.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* seed(makeSession("awaiting_merge", { id: "s_merge", alertId: "C1:merge", prUrl: "https://ghe/pull/1", milestones: { ...NO_MILESTONES, prOpened: true, ciGreen: true } }))
        yield* store.putAction(card({ id: "a_merge", kind: "merge", sessionId: "s_merge", alertId: "C1:merge" }))
        yield* (yield* Actions).dismiss("a_merge")
        return yield* store.getSession("s_merge")
      }),
    )
    expect(session).toMatchObject({ status: "closed", resolution: "PR open, not merged" })
  })

  test("L4: a reply in dry run is recorded closed and says it was not sent", async () => {
    const session = await dry.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* seed(makeSession("waiting", { id: "s_reply", alertId: "C1:reply" }), inbox)
        yield* store.putAction(card({ id: "a_reply", kind: "reply", sessionId: "s_reply", alertId: "C1:reply", detail: "Done, see PR" }))
        yield* (yield* Actions).resolve("a_reply", null)
        return yield* store.getSession("s_reply")
      }),
    )
    expect(session).toMatchObject({ status: "closed", resolution: DRY_RUN_REPLY })
  })

  test("a reply that went out resolves the session", async () => {
    const session = await live.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        const hub = yield* Hub
        yield* hub.updateSettings({ ...(yield* hub.settings), dryRun: false })
        yield* seed(makeSession("waiting", { id: "s_sent", alertId: "C1:sent" }), inbox)
        yield* store.putAction(card({ id: "a_sent", kind: "reply", sessionId: "s_sent", alertId: "C1:sent", detail: "Done" }))
        yield* (yield* Actions).resolve("a_sent", "Done, thanks")
        return yield* store.getSession("s_sent")
      }),
    )
    expect(session).toMatchObject({ status: "resolved", resolution: "replied to Pierre" })
  })
})

describe("deploy tracker edits (M3)", () => {
  const world = makeWorld()
  afterAll(() => world.dispose())
  const tracker = (stage: string, detail: string): Alert =>
    makeAlert({
      id: "C0AUKD42N3U:9.1",
      fields: { _tag: "release", image: "merkl-admin", version: "v0.6.1", actor: null, runId: null, runUrl: null, tag: "admin-v0.6.1", stages: [{ name: stage, status: "failure", detail }] },
    })
  test("only a changed release state moves the session; the hand-off card is not repeated", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        const shipper = yield* Shipper
        yield* seed(makeSession("deploying", { id: "s_dep", alertId: "C1:dep", ciRounds: MAX_CI_ROUNDS, releaseTag: "admin-v0.6.1" }))
        yield* shipper.trackDeploy(tracker("Build", "1 attempt failed"))
        const first = yield* store.getSession("s_dep")
        yield* shipper.trackDeploy(tracker("Build", "1 attempt failed · 👀"))
        yield* shipper.trackDeploy(tracker("ETL", "crash loop"))
        const cards = (yield* store.listActions()).filter((a) => a.sessionId === "s_dep")
        return { first: first?.deployStage, status: (yield* store.getSession("s_dep"))?.status, cards: cards.map((c) => c.title) }
      }),
    )
    expect(out.first).toEqual({ _tag: "Failed", stage: "Build", detail: "1 attempt failed" })
    expect(out.status).toBe("waiting")
    expect(out.cards).toEqual(["Deploy keeps failing · t"])
  })
})

describe("re-triage never overwrites a session you just started (M4)", () => {
  const ts = (Date.now() / 1000 - 60).toFixed(6)
  const id = `C0AUKD42N3U:${ts}`
  const judging = Effect.runSync(Deferred.make<void>())
  const answer = Effect.runSync(Deferred.make<void>())
  const jev = fakeJev({
    judge: () => Deferred.succeed(judging, undefined).pipe(Effect.andThen(Deferred.await(answer)), Effect.as(verdict())),
    judgeInbox: () => Effect.succeed(verdict()),
  })
  const world = makeWorld({ jev, slack: fakeSlack({ latest: postedIn("C0AUKD42N3U", () => [{ ts, text: "API 5xx spike on /v4/opportunities", bot_id: "B1" }]) }) })
  afterAll(() => world.dispose())

  test("the session started during triage stays, and triage does not start a second one", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        const pipeline = yield* AlertPipeline
        yield* store.putAlert(makeAlert({ id, channelId: "C0AUKD42N3U", ts, title: "an older headline", triage: { decision: "ignore", reason: "noise", jev: null } }), "stale")
        const poll = yield* pipeline.pollOnce.pipe(Effect.forkChild)
        yield* Deferred.await(judging)
        yield* (yield* Intake).investigate(id)
        const started = (yield* store.getAlert(id))?.sessionId
        yield* Deferred.succeed(answer, undefined)
        yield* Fiber.join(poll)
        const alert = yield* store.getAlert(id)
        return { started, kept: alert?.sessionId, decision: alert?.triage.decision, sessions: (yield* store.activeSessions()).length }
      }),
    )
    expect(out.started).toBeDefined()
    expect(out.kept).toBe(out.started)
    expect(out.decision).toBe("auto")
    expect(out.sessions).toBe(1)
  })
})
