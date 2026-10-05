import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Fiber } from "effect"
import type { Session } from "../src/domain/model.ts"
import { Asks } from "../src/sessions/asks.ts"
import { SessionRepo } from "../src/sessions/repo.ts"
import { SessionRunner } from "../src/sessions/runner.ts"
import { Store } from "../src/store/store.ts"
import { init, type Play, playingAgent, RESULT } from "./fixtures/agent.ts"
import { makeAlert, makeSession } from "./fixtures/records.ts"
import { makeWorld } from "./fixtures/world.ts"

const OWN_PR = "https://nocturlab.ghe.com/Merkl/monorepo/pull/3401"

/** Handed back with its worktree and agent conversation: your message starts a resumed turn. */
const handedBack = (id: string): Session => makeSession("waiting", { id, alertId: `C1:${id}`, worktree: "/w", claudeSessionId: "c", outcome: "needs_human" })

/** Seeds a handed-back session, sends it a message, and waits until its turn is over. */
const turnOf = async (plays: ReadonlyArray<Play>) => {
  const { agent } = playingAgent(plays)
  const world = makeWorld({ agent })
  try {
    return await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        const runner = yield* SessionRunner
        const session = handedBack("s_turn")
        yield* store.putAlert(makeAlert({ id: session.alertId, sessionId: session.id }))
        yield* store.putSession(session)
        yield* runner.message(session.id, "go")
        while (yield* runner.busy(session.id)) yield* Effect.sleep("10 millis")
        return {
          session: yield* store.getSession(session.id),
          cards: (yield* store.listActions()).map((a) => `${a.kind}: ${a.title}`),
          transcript: (yield* store.transcript(session.id, 50)).map((e) => `${e.kind}: ${e.text}`),
        }
      }),
    )
  } finally {
    await world.dispose()
  }
}

describe("a turn always ends", () => {
  test("report's PR link goes in the transcript; the session's PR is the one its result names", async () => {
    const out = await turnOf([
      { kind: "tool", name: "report", args: { phase: "pr", note: "Opened the fix", prUrl: OWN_PR } },
      { kind: "result", output: RESULT },
    ])
    expect(out.session?.prUrl).toBeNull()
    expect(out.transcript).toContain(`status: pr: Opened the fix ${OWN_PR}`)
  })

  test("a PR on another repo is no PR", async () => {
    const out = await turnOf([{ kind: "result", output: { ...RESULT, outcome: "fix_pr", prUrl: "https://github.com/someone/else/pull/1" } }])
    expect(out.session).toMatchObject({ status: "failed", prUrl: null })
    expect(out.transcript).toContain("error: Ignored the PR link https://github.com/someone/else/pull/1: not a pull request on Merkl/monorepo")
  })

  test("a CLI that exits without a result fails the session instead of leaving it running", async () => {
    const out = await turnOf([])
    expect(out.session).toMatchObject({ status: "failed", activity: "The agent exited without a result" })
    expect(out.cards).toEqual(["review: Agent failed · t"])
  })

  test("a message Bridgetown cannot read is skipped and the turn goes on", async () => {
    const broken: SDKMessage = JSON.parse(JSON.stringify({ ...init("c", "/w"), mcp_servers: null }))
    const out = await turnOf([
      { kind: "message", message: broken },
      { kind: "result", output: RESULT },
    ])
    expect(out.session?.status).toBe("waiting")
    expect(out.transcript.some((line) => line.startsWith("error: Skipped an SDK system message"))).toBe(true)
  })

  test("an ask whose turn dies takes its card and its pending answer with it", async () => {
    const out = await turnOf([
      { kind: "fire", name: "ask", args: { question: "Pin or revert?" } },
      { kind: "crash", reason: "CLI died" },
    ])
    expect(out.session?.status).toBe("failed")
    expect(out.cards).toEqual(["review: Agent failed · t"])
  })
})

describe("asks", () => {
  test("an answer to a session that moved on meanwhile leaves its status alone", async () => {
    const world = makeWorld()
    try {
      const status = await world.runPromise(
        Effect.gen(function* () {
          const store = yield* Store
          const repo = yield* SessionRepo
          const session = makeSession("running", { id: "s_moved", alertId: "C1:moved", worktree: "/w", claudeSessionId: "c" })
          yield* store.putSession(session)
          const asking = yield* (yield* Asks).ask(session, "Pin or revert?", []).pipe(Effect.forkChild)
          while ((yield* store.listActions()).length === 0) yield* Effect.sleep("5 millis")
          yield* repo.patch(session.id, { status: "ci" })
          const card = (yield* store.listActions())[0]
          if (card !== undefined) yield* (yield* Asks).answer(card.id, "pin")
          yield* Fiber.join(asking)
          return (yield* store.getSession(session.id))?.status
        }),
      )
      expect(status).toBe("ci")
    } finally {
      await world.dispose()
    }
  })
})
