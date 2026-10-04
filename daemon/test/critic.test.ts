import { describe, expect, test } from "bun:test"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import { Critic } from "../src/critique/critic.ts"
import type { ReviewerShape, Verdict } from "../src/critique/reviewer.ts"
import { AdapterError } from "../src/domain/errors.ts"
import { NO_MILESTONES, type Session } from "../src/domain/model.ts"
import type { AgentShape } from "../src/sessions/agent.ts"
import type { GitHubShape } from "../src/ship/github.ts"
import { Hub } from "../src/hub.ts"
import { Shipper } from "../src/ship/shipper.ts"
import { Store } from "../src/store/store.ts"
import type { JevShape } from "../src/triage/jev.ts"
import { makeAlert, makeSession } from "./fixtures/records.ts"
import { makeWorld, verdict } from "./fixtures/world.ts"

const PR = "https://ghe/pull/3352"

/** An agent that records what it is sent and never finishes on its own. */
const recordingAgent = () => {
  const seen: Array<SDKUserMessage> = []
  const agent: AgentShape = {
    query: ({ prompt, options }) => {
      const ended = new Promise<IteratorResult<SDKMessage>>((resolve) =>
        options.abortController?.signal.addEventListener("abort", () => resolve({ done: true, value: undefined })),
      )
      void (async () => {
        for await (const message of prompt) seen.push(message)
      })()
      return { [Symbol.asyncIterator]: () => ({ next: () => ended }) }
    },
  }
  return { agent, texts: () => seen.map((m) => (typeof m.message.content === "string" ? m.message.content : "")) }
}

/** GitHub as the critic sees it: the branch head (which a test may move) and `gh pr ready`. */
const fakeGitHub = () => {
  const state = { head: "aaaa111", ready: [] as Array<string> }
  const unused = () => Effect.die("unused")
  const github: GitHubShape = {
    viewPr: unused, mergePr: unused, rerunFailedJobs: unused, nextPatchTag: unused, tagExists: unused, createRelease: unused,
    branchHead: () => Effect.sync(() => state.head),
    prHead: () => Effect.sync(() => state.head),
    markReady: (url) => Effect.sync(() => void state.ready.push(url)),
    reachability: Effect.succeed("ok"),
  }
  return { github, state }
}

const REAL = { file: "packages/api/src/services/reward.ts", line: 88, title: "pending rewards still go through Number()", failureScenario: "a 2^60 wei amount overflows" }
const NIT = { file: "packages/api/src/services/reward.ts", line: 41, title: "Rename amt to amount", failureScenario: "readability" }

const reviewerReturning = (verdict: Verdict, before: () => void = () => {}) => {
  const calls = { count: 0 }
  const reviewer: ReviewerShape = { review: () => Effect.sync(() => { calls.count += 1; before() }).pipe(Effect.as(verdict)) }
  return { reviewer, calls }
}

/** Jev that calls anything titled like a rename a nitpick. */
const jev: JevShape = {
  judge: () => Effect.succeed(verdict()),
  judgeInbox: () => Effect.succeed(verdict()),
  judgeFinding: ({ finding }) =>
    Effect.succeed(
      finding.title.startsWith("Rename")
        ? { realDefect: 0.1, blocking: 0.05, rebutted: null }
        : { realDefect: 0.92, blocking: 0.86, rebutted: null },
    ),
}

const reviewing = (overrides: Partial<Session> = {}): Session =>
  makeSession("critiquing", {
    id: "s_crit", alertId: "C1:crit", prUrl: PR, worktree: "/w", claudeSessionId: "c", phase: "critique",
    milestones: { ...NO_MILESTONES, diagnosed: true, fixed: true, prOpened: true }, ...overrides,
  })

const seed = (session: Session) =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* store.putAlert(makeAlert({ id: session.alertId, sessionId: session.id }))
    yield* store.putSession(session)
  })

/** One critic pass, then the session once the review it started has written its result. */
const tickUntil = (done: (s: Session) => boolean) =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* (yield* Critic).tick
    for (let i = 0; i < 400; i++) {
      const session = yield* store.getSession("s_crit")
      if (session !== undefined && done(session)) return session
      yield* Effect.sleep("5 millis")
    }
    return yield* Effect.die("the review never finished")
  })

const transcript = Effect.gen(function* () {
  return (yield* (yield* Store).transcript("s_crit", 50)).map((e) => `${e.kind}: ${e.text}`)
})

describe("the adversarial review", () => {
  test("a blocking finding goes back to the agent; Jev's nitpick does not", async () => {
    const { agent, texts } = recordingAgent()
    const { github, state } = fakeGitHub()
    const { reviewer } = reviewerReturning({ summary: "misses a path", findings: [REAL, NIT] })
    const world = makeWorld({ agent, github, reviewer, jev })
    try {
      const session = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(reviewing())
          return yield* tickUntil((s) => s.status === "running")
        }),
      )
      expect(session).toMatchObject({ critiqueRounds: 1, phase: "fix", critique: { sha: "aaaa111" } })
      expect(session.critique?.findings.map((f) => [f.title, f.blocks])).toEqual([[REAL.title, true], [NIT.title, false]])
      for (let i = 0; i < 200 && texts().length === 0; i++) await Bun.sleep(5)
      expect(texts()[0]).toContain("An independent reviewer")
      expect(texts()[0]).toContain(REAL.title)
      expect(texts()[0]).not.toContain(NIT.title)
      expect(state.ready).toEqual([])
      expect((await world.runPromise(transcript)).join("\n")).toContain("1 blocking, 1 dropped by Jev")
    } finally {
      await world.dispose()
    }
  })

  test("only nitpicks: the PR leaves draft and goes to CI", async () => {
    const { github, state } = fakeGitHub()
    const { reviewer } = reviewerReturning({ summary: "sound", findings: [NIT] })
    const world = makeWorld({ github, reviewer, jev })
    try {
      const session = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(reviewing({ critiqueRounds: 1 }))
          return yield* tickUntil((s) => s.status === "ci")
        }),
      )
      expect(session).toMatchObject({ phase: "ci", activity: "Waiting for CI", milestones: { critiqued: true }, critique: { sha: "aaaa111" } })
      expect(session.critique?.findings.every((f) => !f.blocks)).toBe(true)
      expect(state.ready).toEqual([PR])
    } finally {
      await world.dispose()
    }
  })

  test("a head that already passed is not reviewed again", async () => {
    const { github, state } = fakeGitHub()
    const { reviewer, calls } = reviewerReturning({ summary: "", findings: [REAL] })
    const world = makeWorld({ github, reviewer, jev })
    try {
      await world.runPromise(
        Effect.gen(function* () {
          yield* seed(reviewing({ critique: { reviewer: "codex", sha: "aaaa111", findings: [], response: null } }))
          return yield* tickUntil((s) => s.status === "ci")
        }),
      )
      expect(calls.count).toBe(0)
      expect(state.ready).toEqual([PR])
    } finally {
      await world.dispose()
    }
  })

  test("turned off in Settings: a session waiting for review goes on to CI unreviewed", async () => {
    const { github, state } = fakeGitHub()
    const { reviewer, calls } = reviewerReturning({ summary: "", findings: [REAL] })
    const world = makeWorld({ github, reviewer, jev })
    try {
      const session = await world.runPromise(
        Effect.gen(function* () {
          const hub = yield* Hub
          yield* hub.updateSettings({ ...(yield* hub.settings), adversarialReview: false })
          yield* seed(reviewing())
          return yield* tickUntil((s) => s.status === "ci")
        }),
      )
      expect(session.milestones.critiqued).toBe(false)
      expect(calls.count).toBe(0)
      expect(state.ready).toEqual([PR])
    } finally {
      await world.dispose()
    }
  })

  test("a failed `gh pr ready` keeps the passed verdict and says what failed", async () => {
    const { github } = fakeGitHub()
    const failing: GitHubShape = { ...github, markReady: () => Effect.fail(new AdapterError({ adapter: "gh", operation: "pr ready", message: "HTTP 502", cause: null })) }
    const { reviewer, calls } = reviewerReturning({ summary: "sound", findings: [] })
    const world = makeWorld({ github: failing, reviewer, jev })
    try {
      const session = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(reviewing())
          return yield* tickUntil((s) => s.critique !== null)
        }),
      )
      expect(session.status).toBe("critiquing")
      for (let i = 0; i < 200 && !(await world.runPromise(transcript)).some((l) => l.includes("HTTP 502")); i++) await Bun.sleep(5)
      expect(await world.runPromise(transcript)).toContain("error: Could not take the PR out of draft: HTTP 502")
      expect(calls.count).toBe(1)
    } finally {
      await world.dispose()
    }
  })

  test("past the review but still a draft (an earlier `gh pr ready` failed): the CI check takes it out of draft", async () => {
    const { github, state } = fakeGitHub()
    const draft = { number: 3352, title: "fix", state: "OPEN", mergedAt: null, isDraft: true, url: PR, reviewDecision: null, latestReviews: [], statusCheckRollup: [] }
    const world = makeWorld({ github: { ...github, viewPr: () => Effect.succeed(draft) }, jev })
    try {
      await world.runPromise(
        Effect.gen(function* () {
          yield* seed(reviewing({ status: "ci", phase: "ci", milestones: { ...NO_MILESTONES, prOpened: true, critiqued: true } }))
          yield* (yield* Shipper).tick
        }),
      )
      expect(state.ready).toEqual([PR])
    } finally {
      await world.dispose()
    }
  })

  test("the branch moved during the review: its result is dropped", async () => {
    const { github, state } = fakeGitHub()
    const { reviewer } = reviewerReturning({ summary: "", findings: [] }, () => void (state.head = "bbbb222"))
    const world = makeWorld({ github, reviewer, jev })
    try {
      const lines = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(reviewing())
          yield* (yield* Critic).tick
          for (let i = 0; i < 400; i++) {
            const lines = yield* transcript
            if (lines.some((l) => l.includes("moved"))) return lines
            yield* Effect.sleep("5 millis")
          }
          return yield* transcript
        }),
      )
      expect(lines).toContain("status: The branch moved during the review; its result is dropped")
      expect(state.ready).toEqual([])
      expect((await world.runPromise(Effect.gen(function* () { return yield* (yield* Store).getSession("s_crit") })))?.status).toBe("critiquing")
    } finally {
      await world.dispose()
    }
  })

  test("without Jev every finding blocks: never laxer than the reviewer", async () => {
    const { agent } = recordingAgent()
    const { github } = fakeGitHub()
    const { reviewer } = reviewerReturning({ summary: "", findings: [NIT] })
    const world = makeWorld({ agent, github, reviewer })
    try {
      const session = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(reviewing())
          return yield* tickUntil((s) => s.status === "running")
        }),
      )
      expect(session.critique?.findings).toEqual([expect.objectContaining({ title: NIT.title, jev: null, blocks: true })])
      expect((await world.runPromise(transcript)).join("\n")).toContain("Jev unavailable: not filtered")
    } finally {
      await world.dispose()
    }
  })

  test("a review that keeps failing to run is handed to you, the PR still in draft", async () => {
    const { github, state } = fakeGitHub()
    const reviewer: ReviewerShape = { review: () => Effect.fail(new AdapterError({ adapter: "codex", operation: "exec", message: "codex is not installed", cause: null })) }
    const world = makeWorld({ github, reviewer, jev })
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          const store = yield* Store
          yield* seed(reviewing())
          for (let round = 1; round <= 3; round++) {
            yield* (yield* Critic).tick
            for (let i = 0; i < 400; i++) {
              if ((yield* transcript).filter((l) => l.startsWith("error: Review could not run")).length >= round) break
              yield* Effect.sleep("5 millis")
            }
          }
          const session = yield* tickUntil((s) => s.status === "waiting")
          return { session, cards: (yield* store.listActions()).map((a) => a.title) }
        }),
      )
      expect(out.session.activity).toBe("Review could not run")
      expect(out.cards).toEqual([expect.stringContaining("Review could not run")])
      expect(state.ready).toEqual([])
    } finally {
      await world.dispose()
    }
  })
})
