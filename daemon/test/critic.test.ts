import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Critic } from "../src/critique/critic.ts"
import type { ReviewerShape, Verdict } from "../src/critique/reviewer.ts"
import { AdapterError } from "../src/domain/errors.ts"
import { NO_MILESTONES, type Session } from "../src/domain/session.ts"
import type { GitHubShape } from "../src/ship/github.ts"
import { Hub } from "../src/hub.ts"
import { Shipper } from "../src/ship/shipper.ts"
import { Store } from "../src/store/store.ts"
import { recordingAgent } from "./support/agent.ts"
import { makeAlert, makeSession } from "./support/records.ts"
import { eventually } from "./support/wait.ts"
import { fakeGitHub, fakeJev, verdict } from "./support/fakes.ts"
import { makeWorld } from "./support/world.ts"

const PR = "https://ghe/pull/3352"

/** GitHub as the critic sees it: the branch head (which a test may move) and `gh pr ready`. */
const criticGitHub = () => {
  const state = { head: "aaaa111", ready: [] as Array<string> }
  const github = fakeGitHub({
    branchHead: () => Effect.sync(() => state.head),
    prHead: () => Effect.sync(() => state.head),
    markReady: (url) => Effect.sync(() => void state.ready.push(url)),
  })
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
const jev = fakeJev({
  judge: () => Effect.succeed(verdict()),
  judgeInbox: () => Effect.succeed(verdict()),
  judgeFinding: ({ finding }) =>
    Effect.succeed(
      finding.title.startsWith("Rename")
        ? { realDefect: 0.1, blocking: 0.05, rebutted: null }
        : { realDefect: 0.92, blocking: 0.86, rebutted: null },
    ),
})

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

/** One critic pass, then the session once the review it started (on the critic's own fiber) has written its result. */
const tickUntil = (done: (s: Session) => boolean) =>
  Effect.gen(function* () {
    yield* (yield* Critic).tick
    return yield* eventually(Store.use((store) => store.getSession("s_crit")), (s) => (s !== undefined && done(s) ? s : undefined))
  })

const transcript = Effect.gen(function* () {
  return (yield* (yield* Store).transcript("s_crit", 50)).map((e) => `${e.kind}: ${e.text}`)
})

describe("the adversarial review", () => {
  test("a blocking finding goes back to the agent; Jev's nitpick does not", async () => {
    const { agent, received } = recordingAgent()
    const { github, state } = criticGitHub()
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
      const [sent] = await received()
      expect(sent).toContain("An independent reviewer")
      expect(sent).toContain(REAL.title)
      expect(sent).not.toContain(NIT.title)
      expect(state.ready).toEqual([])
      expect((await world.runPromise(transcript)).join("\n")).toContain("1 blocking, 1 dropped by Jev")
    } finally {
      await world.dispose()
    }
  })

  test("only nitpicks: the PR leaves draft and goes to CI", async () => {
    const { github, state } = criticGitHub()
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

  test("findings that never reached the agent (parked when the daemon stopped) are delivered, not reviewed again", async () => {
    const { agent, received } = recordingAgent()
    const { github } = criticGitHub()
    const { reviewer, calls } = reviewerReturning({ summary: "", findings: [] })
    const world = makeWorld({ agent, github, reviewer, jev })
    try {
      const recorded = { reviewer: "codex" as const, sha: "aaaa111", findings: [{ ...REAL, jev: null, blocks: true }], response: null }
      const session = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(reviewing({ critique: recorded, critiqueRounds: 2 }))
          return yield* tickUntil((s) => s.status === "running")
        }),
      )
      expect(calls.count).toBe(0)
      expect(session).toMatchObject({ critiqueRounds: 2, phase: "fix" })
      const [sent] = await received()
      expect(sent).toContain(REAL.title)
      expect(sent).toContain("round 2 of")
    } finally {
      await world.dispose()
    }
  })

  test("a head that already passed is not reviewed again", async () => {
    const { github, state } = criticGitHub()
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
    const { github, state } = criticGitHub()
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
    const { github } = criticGitHub()
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
      const lines = await world.runPromise(eventually(transcript, (lines) => (lines.some((l) => l.includes("HTTP 502")) ? lines : undefined)))
      expect(lines).toContain("error: Could not take the PR out of draft: HTTP 502")
      expect(calls.count).toBe(1)
    } finally {
      await world.dispose()
    }
  })

  test("past the review but still a draft (an earlier `gh pr ready` failed): the CI check takes it out of draft", async () => {
    const { github, state } = criticGitHub()
    const draft = { number: 3352, title: "fix", state: "OPEN", mergedAt: null, isDraft: true, headRefOid: "aaaa111", url: PR, reviewDecision: null, latestReviews: [], statusCheckRollup: [] }
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
    const { github, state } = criticGitHub()
    const { reviewer } = reviewerReturning({ summary: "", findings: [] }, () => void (state.head = "bbbb222"))
    const world = makeWorld({ github, reviewer, jev })
    try {
      const lines = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(reviewing())
          yield* (yield* Critic).tick
          return yield* eventually(transcript, (lines) => (lines.some((l) => l.includes("moved")) ? lines : undefined))
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
    const { github } = criticGitHub()
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
    const { github, state } = criticGitHub()
    const reviewer: ReviewerShape = { review: () => Effect.fail(new AdapterError({ adapter: "codex", operation: "exec", message: "codex is not installed", cause: null })) }
    const world = makeWorld({ github, reviewer, jev })
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          const store = yield* Store
          yield* seed(reviewing())
          for (let round = 1; round <= 3; round++) {
            yield* (yield* Critic).tick
            yield* eventually(transcript, (lines) => (lines.filter((l) => l.startsWith("error: Review could not run")).length >= round ? lines : undefined))
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

  test("a session that left review between failures starts its count again when it is back", async () => {
    const { github } = criticGitHub()
    const reviewer: ReviewerShape = { review: () => Effect.fail(new AdapterError({ adapter: "codex", operation: "exec", message: "codex timed out", cause: null })) }
    const world = makeWorld({ github, reviewer, jev })
    const failures = (n: number) => eventually(transcript, (lines) => (lines.filter((l) => l.startsWith("error: Review could not run")).length >= n ? lines : undefined))
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          const store = yield* Store
          yield* seed(reviewing())
          for (let round = 1; round <= 2; round++) {
            yield* (yield* Critic).tick
            yield* failures(round)
          }
          // You messaged it: a turn, out of review, then a new head back in it.
          yield* store.putSession(reviewing({ status: "running" }))
          yield* (yield* Critic).tick
          yield* store.putSession(reviewing())
          yield* (yield* Critic).tick
          yield* failures(3)
          return { session: yield* store.getSession("s_crit"), cards: yield* store.listActions() }
        }),
      )
      expect(out.session?.status).toBe("critiquing")
      expect(out.cards).toEqual([])
    } finally {
      await world.dispose()
    }
  })
})
