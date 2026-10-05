import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Session } from "../src/domain/model.ts"
import { SessionRunner } from "../src/sessions/runner.ts"
import { Store } from "../src/store/store.ts"
import { type Play, playingAgent, RESULT } from "./fixtures/agent.ts"
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

describe("the PR a turn reports", () => {
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
})
