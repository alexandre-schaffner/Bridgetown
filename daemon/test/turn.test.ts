import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Fiber } from "effect"
import { Actions } from "../src/actions/actions.ts"
import { NO_MILESTONES, type Session } from "../src/domain/model.ts"
import { Asks } from "../src/sessions/asks.ts"
import { recoverInterrupted } from "../src/sessions/recovery.ts"
import { SessionRepo } from "../src/sessions/repo.ts"
import { SessionRunner, type SessionRunnerShape } from "../src/sessions/runner.ts"
import type { GitHubShape } from "../src/ship/github.ts"
import { Shipper } from "../src/ship/shipper.ts"
import { Store } from "../src/store/store.ts"
import { init, type Play, playingAgent, RESULT } from "./fixtures/agent.ts"
import { makeAlert, makeSession } from "./fixtures/records.ts"
import { scratchDir } from "./fixtures/tmp.ts"
import { makeWorld } from "./fixtures/world.ts"

const OWN_PR = "https://nocturlab.ghe.com/Merkl/monorepo/pull/3401"

/** Handed back with its worktree and agent conversation: your message starts a resumed turn. */
const handedBack = (id: string): Session => makeSession("waiting", { id, alertId: `C1:${id}`, worktree: "/w", claudeSessionId: "c", outcome: "needs_human" })

/** GitHub that knows nothing and changes nothing. */
const quietGitHub: GitHubShape = {
  viewPr: () => Effect.die("no PR in these tests"),
  mergePr: () => Effect.void,
  rerunFailedJobs: () => Effect.void,
  nextPatchTag: (_repo, prefix) => Effect.succeed(`${prefix}-v0.0.1`),
  tagExists: () => Effect.succeed(false),
  createRelease: () => Effect.void,
  branchHead: () => Effect.succeed(null),
  prHead: () => Effect.succeed(null),
  markReady: () => Effect.void,
  reachability: Effect.succeed("ok"),
}

/** Seeds a session (handed back unless `session` says otherwise), starts a turn on it, and waits until the turn is over. */
const turnOf = async (
  plays: ReadonlyArray<Play>,
  session: Session = handedBack("s_turn"),
  start: (runner: SessionRunnerShape) => Effect.Effect<unknown, unknown, Shipper | Store> = (runner) => runner.message(session.id, "go"),
  github: GitHubShape = quietGitHub,
) => {
  const { agent } = playingAgent(plays)
  const world = makeWorld({ agent, github })
  try {
    return await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        const runner = yield* SessionRunner
        yield* store.putAlert(makeAlert({ id: session.alertId, sessionId: session.id }))
        yield* store.putSession(session)
        yield* start(runner)
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
  test("stopping an agent that asked takes the question down and leaves the session stopped", async () => {
    const out = await turnOf(
      [{ kind: "tool", name: "ask", args: { question: "Pin or revert?" } }],
      handedBack("s_stop"),
      (runner) =>
        Effect.gen(function* () {
          const store = yield* Store
          yield* runner.message("s_stop", "go")
          while ((yield* store.listActions()).length === 0) yield* Effect.sleep("5 millis")
          yield* runner.stop("s_stop")
        }),
    )
    expect(out.session?.status).toBe("stopped")
    expect(out.cards).toEqual([])
  })

  test("closing a session from its card while its agent asks takes the agent down too", async () => {
    const { agent, state } = playingAgent([{ kind: "tool", name: "ask", args: { question: "Pin or revert?" } }])
    const world = makeWorld({ agent, github: quietGitHub })
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          const store = yield* Store
          const session = handedBack("s_close")
          yield* store.putAlert(makeAlert({ id: session.alertId, sessionId: session.id }))
          yield* store.putSession(session)
          yield* store.putAction({
            id: "a_draft", kind: "reply", title: "Reply to Pierre", detail: "draft", primaryLabel: "Send reply", options: [],
            sessionId: session.id, alertId: session.alertId, payload: "draft", url: null, createdAt: "2026-10-01T00:00:00.000Z",
          })
          yield* (yield* SessionRunner).message(session.id, "go")
          while (!(yield* store.listActions()).some((a) => a.kind === "answer")) yield* Effect.sleep("5 millis")
          // Waiting on its question, the session's draft reply still offers to close it.
          yield* (yield* Actions).dismiss("a_draft")
          return { session: yield* store.getSession(session.id), cards: (yield* store.listActions()).length }
        }),
      )
      expect(out.session).toMatchObject({ status: "closed", activity: "Closed by you" })
      expect(out.cards).toBe(0)
      expect(state.aborted).toBe(1)
    } finally {
      await world.dispose()
    }
  })

  test("a question still open when Bridgetown quits is found interrupted at the next start, with a Retry", async () => {
    const home = scratchDir("bt-quit-")
    const { agent } = playingAgent([{ kind: "tool", name: "ask", args: { question: "Pin or revert?" } }])
    const world = makeWorld({ agent, home })
    await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        // A resumed turn: the session already has an outcome, so only its open question says it was mid-turn.
        const session = handedBack("s_quit")
        yield* store.putAlert(makeAlert({ id: session.alertId, sessionId: session.id }))
        yield* store.putSession(session)
        yield* (yield* SessionRunner).message(session.id, "go")
        while ((yield* store.listActions()).length === 0) yield* Effect.sleep("5 millis")
      }),
    )
    await world.dispose()
    const reopened = makeWorld({ home })
    try {
      const out = await reopened.runPromise(
        Effect.gen(function* () {
          yield* recoverInterrupted
          const store = yield* Store
          return { status: (yield* store.getSession("s_quit"))?.status, cards: (yield* store.listActions()).map((a) => `${a.kind}: ${a.title}`) }
        }),
      )
      expect(out).toEqual({ status: "failed", cards: ["review: Interrupted · t"] })
    } finally {
      await reopened.dispose()
    }
  })

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

describe("send-backs", () => {
  test("a failed deploy sent back and answered with a revert recommendation is handed to you", async () => {
    const deploying = makeSession("deploying", {
      id: "s_deploy", alertId: "C1:deploy", worktree: "/w", claudeSessionId: "c", prUrl: OWN_PR, outcome: "fix_pr", rootCauseFound: true,
      release: { image: "merkl-api", tag: "api-v1.2.3", version: "v1.2.3" },
      milestones: { ...NO_MILESTONES, prOpened: true, ciGreen: true, merged: true, released: true },
    })
    const tracker = makeAlert({
      id: "C1:tracker",
      fields: { _tag: "release", image: "merkl-api", version: "v1.2.3", actor: null, runId: null, runUrl: null, tag: "api-v1.2.3", stages: [{ name: "Production", status: "failure", detail: "ETL deploy failed" }] },
    })
    const revert = { ...RESULT, outcome: "recommendation" as const, recommendation: "revert" as const, recommendationDetail: "Revert the PR" }
    const out = await turnOf([{ kind: "result", output: revert }], deploying, () => Shipper.use((shipper) => shipper.trackDeploy(tracker)))
    // What the shipper saw stays recorded; what the turn was sent back for went with the turn that answered it.
    expect(out.session).toMatchObject({
      status: "waiting", sentBack: null, outcome: "recommendation", milestones: { released: true, deployed: false },
      deployStage: { _tag: "Failed", stage: "Production" }, tracker: "C1:tracker",
    })
    expect(out.cards).toEqual(["review: Deploy failed · t"])
  })

  test("a send-back queued behind an ending turn is answered by the next turn, not by the one ending", async () => {
    // The first turn's result waits on `git ls-remote` until the send-back has been queued behind it.
    const reached = Promise.withResolvers<void>()
    const queuedUp = Promise.withResolvers<void>()
    const github: GitHubShape = {
      ...quietGitHub,
      branchHead: () =>
        Effect.promise(async () => {
          reached.resolve()
          await queuedUp.promise
          return null
        }),
    }
    const inCi: Session = { ...handedBack("s_queued"), prUrl: OWN_PR, milestones: { ...NO_MILESTONES, prOpened: true, ciGreen: true } }
    const flaky = { ...RESULT, outcome: "recommendation" as const, recommendation: "rerun_failed_jobs" as const, recommendationDetail: "A flaky runner" }
    const delivered: Array<string> = []
    const out = await turnOf(
      [{ kind: "result", output: flaky }],
      inCi,
      (runner) =>
        Effect.gen(function* () {
          yield* runner.message(inCi.id, "is this flaky?")
          yield* Effect.promise(() => reached.promise)
          delivered.push(yield* runner.continueWith(inCi.id, "CI is red", { sentBack: "ci" }))
          queuedUp.resolve()
        }),
      github,
    )
    expect(delivered).toEqual(["queued"])
    expect(out.session).toMatchObject({ status: "waiting", sentBack: null })
    expect(out.cards).toEqual(["review: CI still red · t"])
  })
})
