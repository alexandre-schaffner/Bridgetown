import { afterAll, describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { Actions } from "../../src/actions/actions.ts"
import type { Action } from "../../src/domain/action.ts"
import { alertFromParsed } from "../../src/domain/alert.ts"
import { progressOf } from "../../src/domain/progress.ts"
import { NO_MILESTONES, type Session } from "../../src/domain/session.ts"
import { Hub } from "../../src/hub.ts"
import { AlertChannels } from "../../src/intake/alerts.ts"
import { SessionRunner } from "../../src/sessions/runner.ts"
import type { PullRequest } from "../../src/ship/github.ts"
import { Shipper } from "../../src/ship/shipper.ts"
import type { SlackMessage } from "../../src/slack/client.ts"
import { parseMessage } from "../../src/slack/parse.ts"
import { Store } from "../../src/store/store.ts"
import { playingAgent, RESULT } from "../support/agent.ts"
import { fakeGitHub, fakeSlack } from "../support/fakes.ts"
import { adminBuildFailed } from "../support/messages.ts"
import { makeAlert, makeSession } from "../support/records.ts"
import { makeWorld } from "../support/world.ts"

const PR = "https://ghe/pull/3345"
const green = [{ name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }]
const red = [{ name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://x/1" }]

/** GitHub as the test sets it: the PR's state, and a tag lookup that waits for `tagLookup` when given. Counts the merges and lookups. */
const prGitHub = (pr: { current: Partial<PullRequest> }, tagLookup?: Deferred.Deferred<void>) => {
  const calls = { merge: 0, nextTag: 0 }
  const github = fakeGitHub({
    viewPr: (url) =>
      Effect.sync(() => ({
        number: 3345, title: "fix(app): import d3-shape from its root", state: "OPEN", mergedAt: null, headRefOid: "aaaa111", url,
        reviewDecision: "APPROVED", latestReviews: [], statusCheckRollup: green, ...pr.current,
      })),
    mergePr: () => Effect.sync(() => void calls.merge++),
    nextPatchTag: (_repo, prefix) =>
      Effect.sync(() => void calls.nextTag++).pipe(
        Effect.andThen(tagLookup === undefined ? Effect.void : Deferred.await(tagLookup)),
        Effect.as(`${prefix}-v2.15.1`),
      ),
  })
  return { github, calls }
}

const mergeCard = (overrides: Partial<Action> = {}): Action => ({
  id: "a_merge", kind: "merge", title: "Merge", detail: "", primaryLabel: "Merge", options: [], sessionId: "s_m", alertId: "C1:m",
  fingerprint: null, retry: false, url: null, createdAt: "2026-10-01T00:00:00.000Z", ...overrides,
})

const shipping = (status: Session["status"], overrides: Partial<Session> = {}) =>
  makeSession(status, {
    id: "s_m", alertId: "C1:m", prUrl: PR, activity: "#3345 approved and green, ready to merge", releasePrefix: "app",
    milestones: { diagnosed: true, fixed: true, prOpened: true, critiqued: true, ciGreen: true, merged: false, released: false, deployed: false },
    ...overrides,
  })

const seed = (session: Session, cards: ReadonlyArray<Action> = []) =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* store.putAlert(makeAlert({ id: session.alertId, sessionId: session.id }))
    yield* store.putSession(session)
    for (const card of cards) yield* store.putAction(card)
  })

const afterTick = Effect.gen(function* () {
  yield* (yield* Shipper).tick
  const store = yield* Store
  return { session: yield* store.getSession("s_m"), cards: yield* store.listActions() }
})

describe("the merge gate is read again every tick", () => {
  test("a PR that went red while waiting to merge goes back to CI, and its Merge card goes", async () => {
    const { github } = prGitHub({ current: { statusCheckRollup: red } })
    const world = makeWorld({ github })
    try {
      const out = await world.runPromise(seed(shipping("awaiting_merge"), [mergeCard()]).pipe(Effect.andThen(afterTick)))
      expect(out.session).toMatchObject({ status: "ci", activity: "CI went red on #3345", milestones: { ciGreen: false } })
      expect(out.cards).toEqual([])
    } finally {
      await world.dispose()
    }
  })

  test("waiting to merge with no card (nothing GitHub took): the card is put back; one GitHub took is left to it", async () => {
    const { github } = prGitHub({ current: {} })
    const world = makeWorld({ github })
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          const bare = yield* seed(shipping("awaiting_merge")).pipe(Effect.andThen(afterTick))
          yield* seed(shipping("awaiting_merge", { mergeRequestedAt: new Date().toISOString() }))
          yield* (yield* Store).deleteActionsWhere(() => true)
          const queued = yield* afterTick
          return { bare: bare.cards.map((c) => c.kind), queued: queued.cards.map((c) => c.kind) }
        }),
      )
      expect(out).toEqual({ bare: ["merge"], queued: [] })
    } finally {
      await world.dispose()
    }
  })

  test("back at the gate after another round: the old Merge card is replaced, not reused", async () => {
    const { github } = prGitHub({ current: {} })
    const world = makeWorld({ github })
    try {
      const out = await world.runPromise(seed(shipping("ci"), [mergeCard({ id: "a_old", detail: "an earlier head" })]).pipe(Effect.andThen(afterTick)))
      expect(out.session?.status).toBe("awaiting_merge")
      expect(out.cards.map((c) => c.id)).not.toContain("a_old")
      expect(out.cards.map((c) => c.detail)).toEqual(["#3345 · CI green, 1 check"])
    } finally {
      await world.dispose()
    }
  })

  test("green and waiting for a review: CI shows done", async () => {
    const { github } = prGitHub({ current: { reviewDecision: "REVIEW_REQUIRED" } })
    const world = makeWorld({ github })
    const reviewed = { channelName: "product-approvals", permalink: null, handledReviewId: null, posted: true }
    try {
      const out = await world.runPromise(seed(shipping("ci", { review: reviewed, milestones: { ...shipping("ci").milestones, ciGreen: false } })).pipe(Effect.andThen(afterTick)))
      expect(out.session).toMatchObject({ status: "ci", milestones: { ciGreen: true } })
    } finally {
      await world.dispose()
    }
  })
})

describe("the review request goes to the team that owns the fix", () => {
  test("by the prefix it ships under, else by the image its release alert names", async () => {
    const { github } = prGitHub({ current: { reviewDecision: "REVIEW_REQUIRED" } })
    const world = makeWorld({ github })
    const engine = makeAlert({
      id: "C1:engine", sessionId: "s_engine",
      fields: { _tag: "release", image: "merkl-engine", version: "v3.1.0", actor: null, runId: null, runUrl: null, tag: "engine-v3.1.0", stages: [] },
    })
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          const store = yield* Store
          yield* seed(shipping("ci", { review: null }))
          yield* store.putAlert(engine)
          yield* store.putSession(shipping("ci", { id: "s_engine", alertId: engine.id, review: null, releasePrefix: null }))
          yield* (yield* Shipper).tick
          return [(yield* store.getSession("s_m"))?.review?.channelName, (yield* store.getSession("s_engine"))?.review?.channelName]
        }),
      )
      expect(out).toEqual(["product-approvals", "general-approvals"])
    } finally {
      await world.dispose()
    }
  })
})

describe("the release gate is offered again after a turn", () => {
  test("back at the gate without its card (a turn took it): the card is put back, once", async () => {
    const { github, calls } = prGitHub({ current: {} })
    const world = makeWorld({ github })
    const merged = { ...shipping("awaiting_release").milestones, merged: true }
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(shipping("awaiting_release", { milestones: merged, activity: "Answered the teammate" }))
          const first = yield* afterTick
          const second = yield* afterTick
          return { session: second.session, first: first.cards.map((c) => c.primaryLabel), second: second.cards.map((c) => c.primaryLabel) }
        }),
      )
      expect(out.first).toEqual(["Cut app-v2.15.1"])
      expect(out.second).toEqual(["Cut app-v2.15.1"])
      expect(out.session).toMatchObject({ status: "awaiting_release", activity: "Merged, ready to cut app-v2.15.1" })
      expect(calls.nextTag).toBe(1)
    } finally {
      await world.dispose()
    }
  })

  test("a release already being cut keeps its tag on the card", async () => {
    const { github, calls } = prGitHub({ current: {} })
    const world = makeWorld({ github })
    const merged = { ...shipping("awaiting_release").milestones, merged: true }
    try {
      const out = await world.runPromise(seed(shipping("awaiting_release", { milestones: merged, releaseTag: "app-v2.15.0" })).pipe(Effect.andThen(afterTick)))
      expect(out.cards.map((c) => c.primaryLabel)).toEqual(["Cut app-v2.15.0"])
      expect(calls.nextTag).toBe(0)
    } finally {
      await world.dispose()
    }
  })
})

describe("a PR closed on GitHub", () => {
  test("closes the session as such, never 'Stopped by you', and its Merge card goes", async () => {
    const { github } = prGitHub({ current: { state: "CLOSED" } })
    const world = makeWorld({ github })
    try {
      const out = await world.runPromise(seed(shipping("awaiting_merge"), [mergeCard()]).pipe(Effect.andThen(afterTick)))
      expect(out.session).toMatchObject({ status: "closed", resolution: "PR closed without merging" })
      expect(out.session === undefined ? null : progressOf(out.session).headline).toBe("Closed · PR closed without merging")
      expect(out.cards).toEqual([])
    } finally {
      await world.dispose()
    }
  })
})

describe("the merge is recorded once", () => {
  test("a Merge click and the ship tick both seeing the merge offer the release once", async () => {
    const lookup = Deferred.makeUnsafe<void>()
    const { github, calls } = prGitHub({ current: { state: "MERGED", mergedAt: "2026-10-05T11:00:00Z" } }, lookup)
    const world = makeWorld({ github })
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(shipping("awaiting_merge"), [mergeCard()])
          const click = yield* (yield* Actions).resolve("a_merge", null).pipe(Effect.forkChild)
          const tick = yield* (yield* Shipper).tick.pipe(Effect.forkChild)
          // Both saw the merge and are looking up the tag: the moment the guard is for.
          while (calls.nextTag < 2) yield* Effect.sleep("5 millis")
          yield* Deferred.succeed(lookup, undefined)
          yield* Fiber.join(click)
          yield* Fiber.join(tick)
          const store = yield* Store
          return { session: yield* store.getSession("s_m"), cards: (yield* store.listActions()).map((c) => c.primaryLabel) }
        }),
      )
      expect(out.session).toMatchObject({ status: "awaiting_release", milestones: { merged: true } })
      expect(out.cards).toEqual(["Cut app-v2.15.1"])
      expect(calls.merge).toBe(0)
    } finally {
      await world.dispose()
    }
  })
})

describe("an inbox session's updates stay out of the teammate's thread", () => {
  test("its merge is not announced in their DM; an alert's is posted in the alert thread", async () => {
    const posts: Array<string> = []
    const { github } = prGitHub({ current: { state: "MERGED", mergedAt: "2026-10-05T11:00:00Z" } })
    const world = makeWorld({ github, env: { forceDryRun: false }, slack: fakeSlack({ post: (_channel, _thread, text) => Effect.sync(() => void posts.push(text)).pipe(Effect.as("1.1")) }) })
    const inbox = { _tag: "inbox" as const, from: "U2", fromName: "Pierre", channelKind: "dm" as const, via: "dm" as const, threadTs: null, prUrl: null }
    try {
      await world.runPromise(
        Effect.gen(function* () {
          yield* (yield* Hub).modifySettings((current) => Effect.succeed({ ...current, dryRun: false }))
          const store = yield* Store
          // Nothing to release: the merge resolves both, and each would announce it.
          yield* store.putAlert(makeAlert({ id: "D1:1", sessionId: "s_in", source: "inbox", fields: inbox }))
          yield* store.putSession(shipping("awaiting_merge", { id: "s_in", alertId: "D1:1", releasePrefix: null }))
          yield* store.putAlert(makeAlert({ id: "C1:m", sessionId: "s_m" }))
          yield* store.putSession(shipping("awaiting_merge", { releasePrefix: null }))
          yield* (yield* Shipper).tick
        }),
      )
      expect(posts).toEqual([`🤖 Merged ${PR}`])
    } finally {
      await world.dispose()
    }
  })
})

const RELEASES = "C0AUKD42N3U"
const TRACKER_TS = adminBuildFailed.ts
const TRACKER_ID = `${RELEASES}:${TRACKER_TS}`

/** The same tracker once its build went green: edited in place, same ts. */
const adminDeployed: SlackMessage = {
  ...adminBuildFailed,
  blocks: JSON.parse(JSON.stringify(adminBuildFailed.blocks).replace(":red_circle:  *Build*\\nBuild failed  ·  _1 attempt failed_", ":large_green_circle:  *Build*\\nImage built")),
  edited: { ts: "1790940000.000000" },
}

const trackerAlert = (sessionId: string | null) => {
  const parsed = parseMessage(adminBuildFailed, { channelId: RELEASES, channelName: "alert-releases", myUserId: undefined })
  return alertFromParsed(parsed, { permalink: null, receivedAt: "2026-10-02T11:23:26.000Z", triage: { decision: "filtered", reason: "r", jev: null }, sessionId, events: [] })
}

const tag = "admin-v0.6.0"
const released = { ...NO_MILESTONES, diagnosed: true, fixed: true, prOpened: true, critiqued: true, ciGreen: true, merged: true, released: true }

describe("a deploy in flight follows its own tracker", () => {
  // Fifteen newer posts: the tracker is no longer among the channel's newest messages.
  const newer: ReadonlyArray<SlackMessage> = Array.from({ length: 15 }, (_, i) => ({
    ts: (Date.now() / 1000 - i * 60).toFixed(6), text: `[RESOLVED] noise ${i}`, bot_id: "B1",
  }))
  const world = makeWorld({
    slack: fakeSlack({
      latest: (channel, _limit, oldest, latest) =>
        Effect.succeed(channel !== RELEASES ? [] : oldest === TRACKER_TS && latest === TRACKER_TS ? [adminDeployed] : newer),
    }),
  })
  afterAll(() => world.dispose())

  test("its edit is read however far down the channel it is, and the deploy resolves the session", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.putAlert(trackerAlert("s_dep"), "before the edit")
        yield* store.putAlert(makeAlert({ id: "C1:dep", sessionId: "s_dep" }))
        yield* store.putSession(
          makeSession("deploying", {
            id: "s_dep", alertId: "C1:dep", releasePrefix: "admin", releaseTag: tag, milestones: released,
            deployStage: { _tag: "AwaitingApproval" }, tracker: { id: TRACKER_ID, applied: "before the edit" },
          }),
        )
        yield* (yield* AlertChannels).poll
        return yield* store.getSession("s_dep")
      }),
    )
    expect(out).toMatchObject({ status: "resolved", resolution: `deployed ${tag}`, milestones: { deployed: true } })
  })
})

describe("a tracker moves only the session that shipped its tag", () => {
  const world = makeWorld()
  afterAll(() => world.dispose())

  test("a PR still in CI, of the release whose failure it fixes, is not resolved by that tracker going green", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.putAlert(makeAlert({ id: "C1:ci", sessionId: "s_ci" }))
        yield* store.putSession(makeSession("ci", { id: "s_ci", alertId: "C1:ci", prUrl: "https://ghe/pull/1", releasePrefix: "admin" }))
        const parsed = parseMessage(adminDeployed, { channelId: RELEASES, channelName: "alert-releases", myUserId: undefined })
        yield* (yield* Shipper).trackDeploy(alertFromParsed(parsed, { permalink: null, receivedAt: "", triage: { decision: "filtered", reason: "r", jev: null }, sessionId: null, events: [] }))
        return yield* store.getSession("s_ci")
      }),
    )
    expect(out).toMatchObject({ status: "ci", deployStage: null, milestones: { deployed: false } })
  })
})

describe("a failed deploy sent back to an agent that cannot resume", () => {
  const world = makeWorld()
  afterAll(() => world.dispose())

  test("is handed to you with what the tracker said recorded, and no send-back pending", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.putAlert(makeAlert({ id: "C1:gone", sessionId: "s_gone" }))
        yield* store.putSession(
          makeSession("deploying", { id: "s_gone", alertId: "C1:gone", worktree: null, releasePrefix: "admin", releaseTag: tag, milestones: released }),
        )
        yield* (yield* Shipper).trackDeploy(trackerAlert(null))
        return { session: yield* store.getSession("s_gone"), cards: (yield* store.listActions()).map((a) => a.title) }
      }),
    )
    expect(out.session).toMatchObject({ status: "waiting", sentBack: null, deployStage: { _tag: "Failed", stage: "Build" }, tracker: { id: TRACKER_ID } })
    expect(out.cards).toEqual(["Agent cannot resume · t"])
  })
})

describe("a tracker edit that comes while the agent is busy", () => {
  const { agent } = playingAgent([
    { kind: "tool", name: "ask", args: { question: "Answer Pierre?" } },
    { kind: "result", output: { ...RESULT, outcome: "no_action", summary: "answered Pierre" } },
  ])
  const world = makeWorld({ agent })
  afterAll(() => world.dispose())

  test("is applied once the turn is over, not lost", async () => {
    const parsed = parseMessage(adminDeployed, { channelId: RELEASES, channelName: "alert-releases", myUserId: undefined })
    const deployed = alertFromParsed(parsed, { permalink: null, receivedAt: "2026-10-02T11:23:26.000Z", triage: { decision: "filtered", reason: "r", jev: null }, sessionId: null, events: [] })
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        const runner = yield* SessionRunner
        yield* store.putAlert(trackerAlert(null), "v1")
        yield* store.putAlert(makeAlert({ id: "C1:busy", sessionId: "s_busy" }))
        yield* store.putSession(
          makeSession("deploying", {
            id: "s_busy", alertId: "C1:busy", worktree: "/w", claudeSessionId: "c", releasePrefix: "admin", releaseTag: tag, milestones: released,
            deployStage: { _tag: "AwaitingApproval" }, tracker: { id: TRACKER_ID, applied: "v1" },
          }),
        )
        // A teammate's question keeps the agent busy while the tracker is edited to deployed.
        yield* runner.continueWith("s_busy", "Pierre asks how it is going")
        while (!(yield* store.listActions()).some((a) => a.kind === "answer")) yield* Effect.sleep("5 millis")
        yield* store.putAlert(deployed, "v2")
        yield* (yield* Shipper).trackDeploy(deployed)
        const whileBusy = (yield* store.getSession("s_busy"))?.milestones.deployed
        yield* runner.message("s_busy", "yes")
        while (yield* runner.busy("s_busy")) yield* Effect.sleep("5 millis")
        yield* (yield* Shipper).tick
        return { whileBusy, after: yield* store.getSession("s_busy") }
      }),
    )
    expect(out.whileBusy).toBe(false)
    expect(out.after).toMatchObject({ status: "resolved", resolution: `deployed ${tag}`, milestones: { deployed: true } })
  })

  test("is progress: a deploy quiet for hours that it moves on is not handed off as stalled in the same tick", async () => {
    const stages = [
      { name: "Approval", status: "success", detail: "" },
      { name: "Build", status: "success", detail: "" },
      { name: "Production", status: "in_progress", detail: "" },
    ] as const
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        const fields = { _tag: "release", image: "merkl-admin", version: "v0.6.0", actor: null, runId: null, runUrl: null, tag, stages } as const
        yield* store.putAlert(makeAlert({ id: "C1:quiet-tracker", fields }), "production started")
        yield* store.putAlert(makeAlert({ id: "C1:quiet", sessionId: "s_quiet" }))
        const quiet = (id: string, deployStage: Session["deployStage"], applied: string | null) =>
          makeSession("deploying", {
            id, alertId: "C1:quiet", releasePrefix: "admin", releaseTag: tag, milestones: released, deployStage,
            tracker: { id: "C1:quiet-tracker", applied }, updatedAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
          })
        yield* store.putSession(quiet("s_quiet", { _tag: "InProgress", stage: "Build" }, null))
        // Its twin already took that version in: nothing came since, so it is stalled.
        yield* store.putSession(quiet("s_stalled", { _tag: "InProgress", stage: "Production" }, "production started"))
        yield* (yield* Shipper).tick
        const cards = yield* store.listActions()
        return {
          moved: yield* store.getSession("s_quiet"),
          stalled: yield* store.getSession("s_stalled"),
          cards: cards.map((a) => `${a.sessionId}: ${a.title}`),
        }
      }),
    )
    expect(out.moved).toMatchObject({ status: "deploying", activity: "Production in progress", deployStage: { _tag: "InProgress", stage: "Production" } })
    expect(out.stalled).toMatchObject({ status: "waiting", activity: "No deploy progress for 3h" })
    expect(out.cards).toEqual(["s_stalled: Deploy stalled · t"])
  })
})

describe("a re-run", () => {
  const reruns: Array<string> = []
  const world = makeWorld({ github: fakeGitHub({ rerunFailedJobs: (runId) => Effect.sync(() => void reruns.push(runId)) }) })
  afterAll(() => world.dispose())

  test("follows the tracker it re-ran, and waits for its next edit: the failure being re-run is not news", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        const shipper = yield* Shipper
        yield* store.putAlert(trackerAlert("s_rerun"), "failed once")
        yield* store.putSession(makeSession("waiting", { id: "s_rerun", alertId: TRACKER_ID, outcome: "recommendation", recommendation: "rerun_failed_jobs" }))
        yield* shipper.rerun("s_rerun")
        yield* shipper.tick
        return yield* store.getSession("s_rerun")
      }),
    )
    expect(reruns).toEqual(["291250187"])
    expect(out).toMatchObject({ status: "deploying", releaseTag: tag, deployStage: null, tracker: { id: TRACKER_ID, applied: "failed once" } })
  })

  test("of an alert that names no workflow run is refused, and the session waits on as it was", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.putAlert(makeAlert({ id: "C1:norun", sessionId: "s_norun" }))
        yield* store.putSession(makeSession("waiting", { id: "s_norun", alertId: "C1:norun", outcome: "recommendation", recommendation: "rerun_failed_jobs" }))
        const before = reruns.length
        const refused = yield* (yield* Shipper).rerun("s_norun").pipe(Effect.flip)
        return { refused: refused.message, rerun: reruns.length - before, session: yield* store.getSession("s_norun") }
      }),
    )
    expect(out).toMatchObject({ refused: "The alert names no workflow run to re-run", rerun: 0, session: { status: "waiting" } })
  })
})
