import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { Actions } from "../../src/actions/actions.ts"
import { ActionQueue } from "../../src/actions/queue.ts"
import { Hub } from "../../src/hub.ts"
import { SlackApiError } from "../../src/domain/errors.ts"
import { Asks } from "../../src/sessions/asks.ts"
import { SessionRepo } from "../../src/sessions/repo.ts"
import { SlackThread } from "../../src/slack/thread.ts"
import { Store } from "../../src/store/store.ts"
import { fakeSlack } from "../support/fakes.ts"
import { makeAlert, makeSession } from "../support/records.ts"
import { eventually } from "../support/wait.ts"
import { makeWorld } from "../support/world.ts"

test("reply evidence distinguishes sent, dry-run and failed attempts", async () => {
  for (const mode of ["dry_run", "sent", "failed"]) {
    const dryRun = mode === "dry_run"
    const world = makeWorld({ env: { forceDryRun: false }, slack: mode === "failed" ? fakeSlack({ post: () => Effect.fail(new SlackApiError({ method: "chat.postMessage", code: "refused", message: "refused" })) }) : fakeSlack() })
    try {
      await world.runPromise(Effect.gen(function* () {
        const store = yield* Store
        const hub = yield* Hub
        yield* hub.updateSettings({ ...(yield* hub.settings), dryRun })
        yield* store.putAlert(makeAlert())
        const card = yield* (yield* ActionQueue).put({ kind: "reply", title: "Reply", detail: "A response", primaryLabel: "Send", options: [], sessionId: null, alertId: "C1:1" })
        const resolved = (yield* Actions).resolve(card.id, "Approved response")
        if (mode === "failed") expect((yield* resolved.pipe(Effect.flip))._tag).toBe("SlackApiError")
        else yield* resolved
        const events = yield* store.pendingMemory()
        expect(events.some((event) => event.text.includes('"result":"attempted"'))).toBe(true)
        expect(events.some((event) => event.text.includes(mode === "sent" ? '"result":"sent"' : '"result":"not_sent"'))).toBe(true)
        expect(events.some((event) => event.text.includes('"result":"sent"'))).toBe(mode === "sent")
        if (mode === "failed") expect(events.some((event) => event.text.includes('"result":"failed"'))).toBe(true)
        if (dryRun) expect(events.some((event) => event.text.includes('"reason":"dry_run"'))).toBe(true)
      }))
    } finally { await world.dispose() }
  }
})

test("question answers retain the question and dismissals do not become user statements", async () => {
  const world = makeWorld()
  try {
    await world.runPromise(Effect.gen(function* () {
      const store = yield* Store
      const asks = yield* Asks
      const actions = yield* Actions
      const session = makeSession("running")
      yield* store.putSession(session)
      for (const dismiss of [false, true]) {
        const pending = yield* asks.ask(session, "Which summary format do you prefer?", ["Bullets", "Paragraphs"]).pipe(Effect.forkChild)
        const card = yield* eventually(store.listActions(), (cards) => cards.find((card) => card.kind === "answer"))
        if (dismiss) yield* actions.dismiss(card.id)
        else yield* actions.resolve(card.id, "Bullets")
        yield* Fiber.join(pending)
      }
      const users = (yield* store.pendingMemory()).filter((event) => event.kind === "user")
      expect(users).toHaveLength(1)
      expect(users[0]?.text).toContain("Which summary format do you prefer?")
      expect(JSON.parse(users[0]?.text ?? "null")).toEqual({ question: "Which summary format do you prefer?", answer: "Bullets" })
    }))
  } finally { await world.dispose() }
})

test("concurrent questions retain each answer's original question", async () => {
  const world = makeWorld()
  try {
    await world.runPromise(Effect.gen(function* () {
      const store = yield* Store
      const asks = yield* Asks
      const session = makeSession("running")
      yield* store.putSession(session)
      const first = yield* asks.ask(session, "Which summary format?", ["Bullets"]).pipe(Effect.forkChild)
      const firstCard = yield* eventually(store.listActions(), (cards) => cards.find((card) => card.title === "Which summary format?"))
      const second = yield* asks.ask(session, "Which deployment day?", ["Friday"]).pipe(Effect.forkChild)
      const secondCard = yield* eventually(store.listActions(), (cards) => cards.find((card) => card.title === "Which deployment day?"))
      yield* asks.answer(firstCard.id, "Bullets")
      yield* asks.answer(secondCard.id, "Friday")
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      const users = (yield* store.pendingMemory()).filter((event) => event.kind === "user")
      expect(users.map((event) => JSON.parse(event.text))).toEqual([
        { question: "Which summary format?", answer: "Bullets" },
        { question: "Which deployment day?", answer: "Friday" },
      ])
    }))
  } finally { await world.dispose() }
})

test("answer text is captured even when it contains the old dismissal marker", async () => {
  const world = makeWorld()
  try {
    await world.runPromise(Effect.gen(function* () {
      const store = yield* Store
      const asks = yield* Asks
      const session = makeSession("running")
      yield* store.putSession(session)
      const pending = yield* asks.ask(session, "Which log message should we preserve?", []).pipe(Effect.forkChild)
      const card = yield* eventually(store.listActions(), (cards) => cards.find((card) => card.kind === "answer"))
      const answer = "Keep the '(The user dismissed' message."
      yield* asks.answer(card.id, answer)
      yield* Fiber.join(pending)
      const users = (yield* store.pendingMemory()).filter((event) => event.kind === "user")
      expect(users).toHaveLength(1)
      expect(JSON.parse(users[0]?.text ?? "null")).toEqual({ question: card.title, answer })
    }))
  } finally { await world.dispose() }
})

test("JSON credentials in watched messages are scrubbed before evidence is persisted", async () => {
  const world = makeWorld()
  try {
    await world.runPromise(Effect.gen(function* () {
      const store = yield* Store
      const raw = JSON.stringify({ password: 'hunter"2', api_key: "generic-service-key-123", authorization: "Bearer generic-access-token" })
      yield* store.putAlert(makeAlert({ receivedAt: new Date().toISOString(), raw }))
      const events = yield* store.pendingMemory()
      expect(events).toHaveLength(1)
      const captured = JSON.parse(events[0]?.text ?? "null")
      expect(JSON.parse(captured.raw)).toEqual({ password: "[redacted]", api_key: "[redacted]", authorization: "[redacted]" })
    }))
  } finally { await world.dispose() }
})

test("agent diagnosis is a claim while failed session state is an observed outcome", async () => {
  const world = makeWorld()
  try {
    await world.runPromise(Effect.gen(function* () {
      const store = yield* Store
      const repo = yield* SessionRepo
      yield* store.putSession(makeSession("running"))
      yield* repo.patch("s", { diagnosis: "Suspects the cache", rootCauseFound: false })
      yield* repo.patch("s", { status: "failed", resolution: "agent failed" })
      const events = yield* store.pendingMemory()
      expect(events.some((event) => event.kind === "finding" && event.text.includes("Suspects the cache"))).toBe(true)
      expect(events.filter((event) => event.kind === "outcome").every((event) => !event.text.includes("Suspects the cache"))).toBe(true)
      expect(events.some((event) => event.kind === "outcome" && event.text.includes('"status":"failed"'))).toBe(true)
    }))
  } finally { await world.dispose() }
})

test("repeated thread polls deduplicate fresh content, capture edits and skip historical messages", async () => {
  const ts = String((Date.now() + 1_000) / 1000)
  let text = "Team owns billing"
  let edited = false
  const world = makeWorld({ slack: fakeSlack({ replies: () => Effect.succeed([
    { ts: "2", text: edited ? "New correction to old message" : "Historical", user: "U2", ...(edited ? { edited: { ts } } : {}) }, { ts, text, user: "U2" },
  ]) }) })
  try {
    await world.runPromise(Effect.gen(function* () {
      const thread = yield* SlackThread
      const store = yield* Store
      yield* thread.messages(makeAlert())
      yield* thread.messages(makeAlert())
      expect(yield* store.pendingMemoryCount).toBe(1)
      text = "Platform owns billing"
      yield* thread.messages(makeAlert())
      expect(yield* store.pendingMemoryCount).toBe(2)
      expect((yield* store.pendingMemory()).every((event) => !event.text.includes("Historical"))).toBe(true)
      edited = true
      yield* thread.messages(makeAlert())
      yield* thread.messages(makeAlert())
      expect(yield* store.pendingMemoryCount).toBe(3)
    }))
  } finally { await world.dispose() }
})
