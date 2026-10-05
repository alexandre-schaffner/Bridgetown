import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Actions } from "../src/actions/actions.ts"
import { SlackApiError } from "../src/domain/errors.ts"
import { type Action, type Alert, RETRY, type Session } from "../src/domain/model.ts"
import { Hub } from "../src/hub.ts"
import { Store } from "../src/store/store.ts"
import { makeAlert, makeSession } from "./fixtures/records.ts"
import { fakeSlack, makeWorld } from "./fixtures/world.ts"

const card = (overrides: Partial<Action>): Action => ({
  id: "a_x", kind: "review", title: "t", detail: "", primaryLabel: "Close session", options: [], sessionId: null, alertId: null,
  payload: null, url: null, createdAt: "2026-10-01T00:00:00.000Z", ...overrides,
})

const seed = (alert: Partial<Alert>, action: Action, session?: Session) =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* store.putAlert(makeAlert(alert))
    if (session !== undefined) yield* store.putSession(session)
    yield* store.putAction(action)
  })

const world = makeWorld()
const failingSlack = makeWorld({
  dryRun: false,
  slack: { ...fakeSlack(() => []), post: (method) => Effect.fail(new SlackApiError({ method, code: "channel_not_found", message: "channel_not_found" })) },
})
afterAll(async () => {
  await world.dispose()
  await failingSlack.dispose()
})

const events = (id: string) => Effect.gen(function* () {
  const alert = yield* (yield* Store).getAlert(id)
  return { events: alert?.events.map((e) => e.text), disposition: alert?.disposition?.kind ?? null }
})

describe("dismiss", () => {
  test("a suggestion: recorded as dismissed, no agent started", async () => {
    const out = await world.runPromise(Effect.gen(function* () {
      yield* seed({ id: "C1:sugg" }, card({ id: "a_sugg", kind: "investigate", alertId: "C1:sugg" }))
      yield* (yield* Actions).dismiss("a_sugg")
      return { ...(yield* events("C1:sugg")), cards: (yield* (yield* Store).listActions()).map((a) => a.id) }
    }))
    expect(out).toEqual({ events: ["Dismissed by you, no agent started"], disposition: "dismissed", cards: [] })
  })

  test("an escalation: dismissed without opening it", async () => {
    const out = await world.runPromise(Effect.gen(function* () {
      yield* seed({ id: "C1:esc" }, card({ id: "a_esc", kind: "escalate", alertId: "C1:esc" }))
      yield* (yield* Actions).dismiss("a_esc")
      return yield* events("C1:esc")
    }))
    expect(out).toEqual({ events: ["Dismissed by you without opening it"], disposition: "dismissed" })
  })

  test("a card of a session that is still moving leaves the session alone", async () => {
    const out = await world.runPromise(Effect.gen(function* () {
      yield* seed({ id: "C1:ci" }, card({ id: "a_ci", kind: "reply", sessionId: "s_ci", alertId: "C1:ci" }), makeSession("ci", { id: "s_ci", alertId: "C1:ci" }))
      yield* (yield* Actions).dismiss("a_ci")
      return (yield* (yield* Store).getSession("s_ci"))?.status
    }))
    expect(out).toBe("ci")
  })
})

describe("resolve", () => {
  test("escalate: recorded as opened by you", async () => {
    const out = await world.runPromise(Effect.gen(function* () {
      yield* seed({ id: "C1:open" }, card({ id: "a_open", kind: "escalate", alertId: "C1:open" }))
      yield* (yield* Actions).resolve("a_open", null)
      return yield* events("C1:open")
    }))
    expect(out).toEqual({ events: ["Opened by you in Slack or Revv"], disposition: "opened" })
  })

  test("review on a failed session with Retry: queued again, conversation kept", async () => {
    const out = await world.runPromise(Effect.gen(function* () {
      const failed = makeSession("failed", { id: "s_retry", alertId: "C1:retry", claudeSessionId: "c", resolution: "agent failed" })
      yield* seed({ id: "C1:retry", sessionId: "s_retry" }, card({ id: "a_retry", kind: "review", sessionId: "s_retry", alertId: "C1:retry", payload: RETRY, primaryLabel: "Retry" }), failed)
      yield* (yield* Actions).resolve("a_retry", null)
      return yield* (yield* Store).getSession("s_retry")
    }))
    expect(out).toMatchObject({ status: "queued", resolution: null, claudeSessionId: "c" })
  })

  test("review on a waiting session: closed with an honest resolution, never resolved", async () => {
    const out = await world.runPromise(Effect.gen(function* () {
      const waiting = makeSession("waiting", { id: "s_close", alertId: "C1:close", rootCauseFound: false })
      yield* seed({ id: "C1:close", sessionId: "s_close" }, card({ id: "a_close", kind: "review", sessionId: "s_close", alertId: "C1:close" }), waiting)
      yield* (yield* Actions).resolve("a_close", null)
      return yield* (yield* Store).getSession("s_close")
    }))
    expect(out).toMatchObject({ status: "closed", resolution: "root cause not found" })
  })

  test("a reply Slack refuses keeps the card and fails with SlackApiError (HTTP 500), nothing recorded", async () => {
    const out = await failingSlack.runPromise(Effect.gen(function* () {
      const store = yield* Store
      const hub = yield* Hub
      yield* hub.updateSettings({ ...(yield* hub.settings), dryRun: false })
      const waiting = makeSession("waiting", { id: "s_rep", alertId: "C1:rep" })
      yield* seed({ id: "C1:rep", sessionId: "s_rep" }, card({ id: "a_rep", kind: "reply", sessionId: "s_rep", alertId: "C1:rep", payload: "draft" }), waiting)
      const error = yield* (yield* Actions).resolve("a_rep", "Done").pipe(Effect.flip)
      return { error, cards: (yield* store.listActions()).map((a) => a.id), status: (yield* store.getSession("s_rep"))?.status }
    }))
    expect(out.error).toMatchObject({ _tag: "SlackApiError", code: "not_posted" })
    expect(out.cards).toContain("a_rep")
    expect(out.status).toBe("waiting")
  })

  test("a hand-off card of a session you since messaged back to work: the card goes, the session keeps running", async () => {
    const out = await world.runPromise(Effect.gen(function* () {
      const running = makeSession("running", { id: "s_moved", alertId: "C1:moved" })
      yield* seed({ id: "C1:moved", sessionId: "s_moved" }, card({ id: "a_moved", kind: "review", sessionId: "s_moved", alertId: "C1:moved" }), running)
      const failure = yield* (yield* Actions).resolve("a_moved", null).pipe(Effect.flip)
      const store = yield* Store
      return { failure: failure._tag, status: (yield* store.getSession("s_moved"))?.status, cards: (yield* store.listActions()).map((a) => a.id) }
    }))
    expect(out).toEqual({ failure: "Conflict", status: "running", cards: [] })
  })

  test("an unknown action is NotFound", async () => {
    const error = await world.runPromise(Actions.use((actions) => actions.resolve("a_nope", null)).pipe(Effect.flip))
    expect(error._tag).toBe("NotFound")
  })
})
