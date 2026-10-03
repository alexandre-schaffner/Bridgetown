import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { Actions } from "../src/actions/actions.ts"
import { snapshot } from "../src/api/views.ts"
import { AdapterError } from "../src/domain/errors.ts"
import type { Action, Session } from "../src/domain/model.ts"
import type { GitHubShape } from "../src/ship/github.ts"
import { Store } from "../src/store/store.ts"
import { makeAlert, makeSession } from "./fixtures/records.ts"
import { makeWorld } from "./fixtures/world.ts"

/** GitHub whose `gh pr merge` / `gh release create` wait for `release` to be completed, counting the calls that act. */
const slowGitHub = (release: Deferred.Deferred<void>, options: { readonly createFails?: boolean } = {}) => {
  const calls = { merge: 0, create: 0 }
  const state = { merged: false, tags: ["dispute-v0.4.2"] }
  const github: GitHubShape = {
    viewPr: (url) =>
      Effect.succeed({
        number: 3338, title: "fix", state: state.merged ? "MERGED" : "OPEN", mergedAt: state.merged ? "now" : null, url,
        reviewDecision: "APPROVED", latestReviews: [], statusCheckRollup: [],
      }),
    mergePr: () => Effect.sync(() => void calls.merge++).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.sync(() => void (state.merged = true)))),
    rerunFailedJobs: () => Effect.void,
    nextPatchTag: (_repo, prefix) => Effect.succeed(`${prefix}-v0.4.3`),
    tagExists: (_repo, tag) => Effect.sync(() => state.tags.includes(tag)),
    createRelease: (tag) =>
      Effect.sync(() => void calls.create++).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(
          options.createFails === true
            ? Effect.fail(new AdapterError({ adapter: "gh", operation: "release create", message: "HTTP 502", cause: null }))
            : Effect.sync(() => void state.tags.push(tag)),
        ),
      ),
    branchPushed: () => Effect.succeed(true),
    reachability: Effect.succeed("ok"),
  }
  return { github, calls }
}

const releasable: Session = makeSession("awaiting_release", {
  id: "s_rel", alertId: "C1:rel", prUrl: "https://ghe/pull/3338", activity: "Merged, ready to cut dispute-v0.4.3",
  release: { image: "merkl-dispute", tag: "dispute", version: "" },
  milestones: { diagnosed: true, fixed: true, prOpened: true, ciGreen: true, merged: true, released: false, deployed: false },
})
const releaseCard: Action = {
  id: "a_rel", kind: "release", title: "Ship", detail: "", primaryLabel: "Cut dispute-v0.4.3", options: [], sessionId: "s_rel", alertId: "C1:rel",
  payload: "dispute-v0.4.3", url: null, createdAt: "2026-10-01T00:00:00.000Z",
}

const seed = (session: Session, card: Action) =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* store.putAlert(makeAlert({ id: session.alertId, sessionId: session.id }))
    yield* store.putSession(session)
    yield* store.putAction(card)
  })

const waitFor = <A>(read: Effect.Effect<A, unknown, Store>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (;;) {
      const value = yield* read
      if (done(value)) return value
      yield* Effect.sleep("5 millis")
    }
  })

describe("the release gate through the real shipper", () => {
  test("in flight: the card says so, the session says what is happening, a second click is a 409; then it deploys, once", async () => {
    const release = Deferred.makeUnsafe<void>()
    const { github, calls } = slowGitHub(release)
    const world = makeWorld({ github })
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(releasable, releaseCard)
          const actions = yield* Actions
          const store = yield* Store
          const first = yield* actions.resolve("a_rel", null).pipe(Effect.forkChild)
          yield* waitFor(store.getSession("s_rel"), (s) => s?.releaseTag === "dispute-v0.4.3")
          const during = yield* snapshot
          const second = yield* actions.resolve("a_rel", null).pipe(Effect.flip)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(first)
          return { during, second, after: yield* store.getSession("s_rel"), cards: yield* store.listActions() }
        }),
      )
      expect(out.during.actions.find((a) => a.id === "a_rel")?.inFlight).toBe(true)
      expect(out.during.sessions.find((s) => s.id === "s_rel")?.activity).toBe("Cutting dispute-v0.4.3…")
      expect(out.second._tag).toBe("Conflict")
      expect(out.after).toMatchObject({ status: "deploying", releaseTag: "dispute-v0.4.3", activity: "Released dispute-v0.4.3, waiting for approval" })
      expect(out.cards).toEqual([])
      expect(calls.create).toBe(1)
    } finally {
      await world.dispose()
    }
  })

  test("a release GitHub refused leaves the card, clears the tag and puts the status line back", async () => {
    const release = Deferred.makeUnsafe<void>()
    await Effect.runPromise(Deferred.succeed(release, undefined))
    const { github } = slowGitHub(release, { createFails: true })
    const world = makeWorld({ github })
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(releasable, releaseCard)
          const failure = yield* (yield* Actions).resolve("a_rel", null).pipe(Effect.flip)
          const store = yield* Store
          return { failure, session: yield* store.getSession("s_rel"), cards: (yield* store.listActions()).map((a) => a.id) }
        }),
      )
      expect(out.failure._tag).toBe("AdapterError")
      expect(out.session).toMatchObject({ status: "awaiting_release", releaseTag: null, activity: "Merged, ready to cut dispute-v0.4.3" })
      expect(out.cards).toEqual(["a_rel"])
    } finally {
      await world.dispose()
    }
  })

  test("merging says so while GitHub works, then offers the release", async () => {
    const release = Deferred.makeUnsafe<void>()
    const { github, calls } = slowGitHub(release)
    const world = makeWorld({ github })
    const mergeable = makeSession("awaiting_merge", {
      id: "s_rel", alertId: "C1:rel", prUrl: "https://ghe/pull/3338", activity: "#3338 approved and green, ready to merge",
      release: { image: "merkl-dispute", tag: "dispute", version: "" },
      milestones: { diagnosed: true, fixed: true, prOpened: true, ciGreen: true, merged: false, released: false, deployed: false },
    })
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(mergeable, { ...releaseCard, id: "a_merge", kind: "merge", primaryLabel: "Merge", payload: mergeable.prUrl })
          const store = yield* Store
          const first = yield* (yield* Actions).resolve("a_merge", null).pipe(Effect.forkChild)
          const during = yield* waitFor(store.getSession("s_rel"), (s) => s?.mergeRequestedAt !== null)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(first)
          return { during, after: yield* store.getSession("s_rel"), cards: (yield* store.listActions()).map((a) => a.primaryLabel) }
        }),
      )
      expect(out.during?.activity).toBe("Merging #3338…")
      expect(out.after).toMatchObject({ status: "awaiting_release", activity: "Merged, ready to cut dispute-v0.4.3" })
      expect(out.cards).toEqual(["Cut dispute-v0.4.3"])
      expect(calls.merge).toBe(1)
    } finally {
      await world.dispose()
    }
  })
})
