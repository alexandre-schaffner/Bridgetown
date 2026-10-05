import { describe, expect, test } from "bun:test"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit, Fiber } from "effect"
import type { Session } from "../src/domain/model.ts"
import { Hub } from "../src/hub.ts"
import type { AgentShape } from "../src/sessions/agent.ts"
import { Asks } from "../src/sessions/asks.ts"
import { SessionRepo } from "../src/sessions/repo.ts"
import { SessionRunner } from "../src/sessions/runner.ts"
import { Store } from "../src/store/store.ts"
import { makeAlert, makeSession } from "./fixtures/records.ts"
import { scratchDir } from "./fixtures/tmp.ts"
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

describe("a new turn", () => {
  test("takes down the hand-off it supersedes, which would otherwise close the session mid-turn", async () => {
    const { agent, texts } = recordingAgent()
    const world = makeWorld({ agent })
    try {
      await world.runPromise(Effect.gen(function* () {
        const store = yield* Store
        yield* seed(handedBack("s_reopen"))
        yield* store.putAction({
          id: "a_handoff", kind: "review", title: "Root cause not found · t", detail: "", primaryLabel: "Close session", options: [],
          sessionId: "s_reopen", alertId: "C1:s_reopen", payload: null, url: null, createdAt: "2026-10-01T00:00:00.000Z",
        })
        yield* (yield* SessionRunner).message("s_reopen", "look again")
      }))
      await until(() => texts().includes("look again"))
      expect(await world.runPromise(Store.use((store) => store.listActions()))).toEqual([])
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

describe("stop and retry", () => {
  test("a send-back racing a stop never leaves a turn running on the stopped session", async () => {
    const { agent } = recordingAgent()
    const world = makeWorld({ agent })
    try {
      const outcomes = await world.runPromise(
        Effect.forEach(Array.from({ length: 20 }, (_, i) => `s_race${i}`), (id) =>
          Effect.gen(function* () {
            const runner = yield* SessionRunner
            yield* seed({ ...handedBack(id), status: "ci" })
            yield* Effect.all([runner.continueWith(id, "CI red"), runner.stop(id)], { concurrency: "unbounded" })
            return { busy: yield* runner.busy(id), status: (yield* (yield* Store).getSession(id))?.status }
          }),
        ),
      )
      expect(outcomes.every((o) => !o.busy && o.status === "stopped")).toBe(true)
    } finally {
      await world.dispose()
    }
  })

  test("retry while the failed turn still holds the session is a conflict, so its card stays", async () => {
    const { agent, texts } = recordingAgent()
    const world = makeWorld({ agent })
    try {
      await world.runPromise(Effect.gen(function* () {
        yield* seed(handedBack("s_retry"))
        yield* (yield* SessionRunner).message("s_retry", "go")
      }))
      await until(() => texts().includes("go"))
      const exit = await world.runPromise(Effect.gen(function* () {
        yield* (yield* SessionRepo).patch("s_retry", { status: "failed" })
        return yield* (yield* SessionRunner).retry("s_retry").pipe(Effect.exit)
      }))
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await world.dispose()
    }
  })
})

describe("deliveries", () => {
  test("a send-back into a live turn still records its patch", async () => {
    const { agent, texts } = recordingAgent()
    const world = makeWorld({ agent })
    try {
      await world.runPromise(Effect.gen(function* () {
        yield* seed({ ...handedBack("s_patch"), status: "ci" })
        yield* (yield* SessionRunner).message("s_patch", "go")
      }))
      await until(() => texts().includes("go"))
      const out = await world.runPromise(Effect.gen(function* () {
        const delivery = yield* (yield* SessionRunner).continueWith("s_patch", "CI red", { ciRounds: 2 })
        return { delivery, ciRounds: (yield* (yield* Store).getSession("s_patch"))?.ciRounds }
      }))
      expect(out).toEqual({ delivery: "sent", ciRounds: 2 })
    } finally {
      await world.dispose()
    }
  })

  test("a parked turn that can no longer start, or that the daemon quits on, says it was not delivered", async () => {
    const home = scratchDir("bt-parked-")
    const world = makeWorld({ home })
    await world.runPromise(Effect.gen(function* () {
      const hub = yield* Hub
      const runner = yield* SessionRunner
      yield* hub.updateSettings({ ...(yield* hub.settings), maxConcurrent: 1 })
      yield* seed(makeSession("running", { id: "s_slot", alertId: "C1:slot" }))
      yield* seed(handedBack("s_gone"))
      yield* seed(handedBack("s_quit"))
      const repo = yield* SessionRepo
      yield* runner.message("s_gone", "first")
      // s_gone loses its worktree while it waits; then the slot frees up.
      yield* repo.patch("s_gone", { worktree: null })
      yield* repo.patch("s_slot", { status: "ci" })
      yield* runner.tick
      // The slot is taken again, and s_quit is still waiting for it when the daemon quits.
      yield* repo.patch("s_slot", { status: "running" })
      yield* runner.message("s_quit", "second")
    }))
    await world.dispose()
    const reopened = makeWorld({ home })
    try {
      const lines = await reopened.runPromise(Effect.gen(function* () {
        const store = yield* Store
        return {
          gone: (yield* store.transcript("s_gone", 10)).map((e) => e.text),
          quit: (yield* store.transcript("s_quit", 10)).map((e) => e.text),
        }
      }))
      expect(lines.gone).toContain("Not delivered: the session no longer takes messages")
      expect(lines.quit.at(-1)).toBe("Not delivered: Bridgetown quit while it waited for an agent slot")
    } finally {
      await reopened.dispose()
    }
  })
})
