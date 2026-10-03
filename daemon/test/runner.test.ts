import { describe, expect, test } from "bun:test"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Fiber } from "effect"
import type { Session } from "../src/domain/model.ts"
import type { AgentShape } from "../src/sessions/agent.ts"
import { Asks } from "../src/sessions/asks.ts"
import { SessionRunner } from "../src/sessions/runner.ts"
import { Store } from "../src/store/store.ts"
import { makeAlert, makeSession } from "./fixtures/records.ts"
import { makeWorld } from "./fixtures/world.ts"

/**
 * An agent that reads its streaming input and never finishes on its own: it
 * records every user message, and ends only when its query is aborted.
 */
const recordingAgent = () => {
  const seen: Array<SDKUserMessage> = []
  const state = { queries: 0, aborted: 0 }
  const agent: AgentShape = {
    query: ({ prompt, options }) => {
      state.queries += 1
      const ended = new Promise<IteratorResult<SDKMessage>>((resolve) =>
        options.abortController?.signal.addEventListener("abort", () => {
          state.aborted += 1
          resolve({ done: true, value: undefined })
        }),
      )
      void (async () => {
        for await (const message of prompt) seen.push(message)
      })()
      return { [Symbol.asyncIterator]: () => ({ next: () => ended }) }
    },
  }
  const texts = () => seen.map((m) => (typeof m.message.content === "string" ? m.message.content : ""))
  return { agent, seen, state, texts }
}

const until = async (condition: () => boolean, ms = 2_000) => {
  for (const deadline = Date.now() + ms; !condition() && Date.now() < deadline; ) await Bun.sleep(10)
  expect(condition()).toBe(true)
}

/** Handed back with its worktree and agent conversation: it takes messages, and one starts a resumed turn. */
const handedBack = (id: string): Session => makeSession("waiting", { id, alertId: `C1:${id}`, worktree: "/w", claudeSessionId: "c" })

const seed = (session: Session) =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* store.putAlert(makeAlert({ id: session.alertId, sessionId: session.id }))
    yield* store.putSession(session)
  })

describe("your message", () => {
  test("answers a pending ask: the tool call gets the text, the card goes, the transcript says so", async () => {
    const world = makeWorld()
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          const store = yield* Store
          const session = handedBack("s_ask")
          yield* seed(session)
          const asking = yield* (yield* Asks).ask(session, "Pin or revert?", ["pin", "revert"]).pipe(Effect.forkChild)
          while ((yield* store.listActions()).length === 0) yield* Effect.sleep("5 millis")
          yield* (yield* SessionRunner).message("s_ask", "pin it")
          return {
            reply: yield* Fiber.join(asking),
            cards: (yield* store.listActions()).length,
            status: (yield* store.getSession("s_ask"))?.status,
            transcript: (yield* store.transcript("s_ask", 20)).map((e) => `${e.kind}: ${e.text}`),
          }
        }),
      )
      expect(out.reply).toBe("pin it")
      expect(out.cards).toBe(0)
      expect(out.status).toBe("running")
      expect(out.transcript).toEqual(expect.arrayContaining(["text: You: pin it", "status: You answered: pin it"]))
    } finally {
      await world.dispose()
    }
  })

  test("reaches a live turn's input at once, marked for the agent's next step", async () => {
    const { agent, seen, state, texts } = recordingAgent()
    const world = makeWorld({ agent })
    try {
      await world.runPromise(Effect.gen(function* () {
        yield* seed(handedBack("s_live"))
        yield* (yield* SessionRunner).message("s_live", "first")
      }))
      await until(() => texts().includes("first"))
      const after = await world.runPromise(Effect.gen(function* () {
        const runner = yield* SessionRunner
        yield* runner.message("s_live", "also check the cron")
        return { busy: yield* runner.busy("s_live"), session: yield* (yield* Store).getSession("s_live") }
      }))
      await until(() => texts().includes("also check the cron"))
      expect(seen.find((m) => m.message.content === "also check the cron")?.priority).toBe("next")
      expect(state.queries).toBe(1)
      expect(after.busy).toBe(true)
      expect(after.session).toMatchObject({ status: "running", activity: "Read your message" })
      const transcript = await world.runPromise(Store.use((store) => store.transcript("s_live", 20)))
      expect(transcript.filter((e) => e.kind === "text").map((e) => e.text)).toEqual(["You: first", "You: also check the cron"])
    } finally {
      await world.dispose()
    }
  })
})

describe("session fibers", () => {
  test("stop interrupts the turn: the query is aborted and the session ends stopped", async () => {
    const { agent, state, texts } = recordingAgent()
    const world = makeWorld({ agent })
    try {
      await world.runPromise(Effect.gen(function* () {
        yield* seed(handedBack("s_stop"))
        yield* (yield* SessionRunner).message("s_stop", "go")
      }))
      await until(() => texts().includes("go"))
      const out = await world.runPromise(Effect.gen(function* () {
        const runner = yield* SessionRunner
        yield* runner.stop("s_stop")
        return { busy: yield* runner.busy("s_stop"), status: (yield* (yield* Store).getSession("s_stop"))?.status }
      }))
      expect(out).toEqual({ busy: false, status: "stopped" })
      expect(state.aborted).toBe(1)
    } finally {
      await world.dispose()
    }
  })

  test("layer shutdown interrupts running sessions: their queries are aborted", async () => {
    const { agent, state, texts } = recordingAgent()
    const world = makeWorld({ agent })
    await world.runPromise(Effect.gen(function* () {
      yield* seed(handedBack("s_a"))
      yield* seed(handedBack("s_b"))
      const runner = yield* SessionRunner
      yield* runner.message("s_a", "one")
      yield* runner.message("s_b", "two")
    }))
    await until(() => texts().includes("one") && texts().includes("two"))
    expect(state.aborted).toBe(0)
    const started = Date.now()
    await world.dispose()
    expect(state.aborted).toBe(2)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
