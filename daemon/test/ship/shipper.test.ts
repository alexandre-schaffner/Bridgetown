import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { Actions } from "../../src/actions/actions.ts"
import type { Action } from "../../src/domain/action.ts"
import { progressOf } from "../../src/domain/progress.ts"
import type { Session } from "../../src/domain/session.ts"
import { Hub } from "../../src/hub.ts"
import type { PullRequest } from "../../src/ship/github.ts"
import { Shipper } from "../../src/ship/shipper.ts"
import { Store } from "../../src/store/store.ts"
import { fakeGitHub, fakeSlack } from "../support/fakes.ts"
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
