import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { Actions } from "../../src/actions/actions.ts"
import { snapshot } from "../../src/api/views.ts"
import type { Action } from "../../src/domain/action.ts"
import { AdapterError } from "../../src/domain/errors.ts"
import { NO_MILESTONES, type Session, type SessionStatus } from "../../src/domain/session.ts"
import { mergeOnce, releaseOnce } from "../../src/ship/gates.ts"
import { Shipper } from "../../src/ship/shipper.ts"
import { Store } from "../../src/store/store.ts"
import { fakeGitHub } from "../support/fakes.ts"
import { makeAlert, makeSession } from "../support/records.ts"
import { eventually } from "../support/wait.ts"
import { makeWorld } from "../support/world.ts"

const session = (status: SessionStatus, overrides: Partial<Session> = {}): Session =>
  makeSession(status, { prUrl: "https://ghe/pull/1", agentSessionId: "c", ...overrides })

const fail = (message: string) => Effect.fail(new AdapterError({ adapter: "gh", operation: "test", message, cause: null }))

/** A session row plus a fake GitHub, counting every call that acts. `movedOn`: the session left the gate, so nothing is written. */
const world = (initial: Session) => {
  let row = initial
  const calls = { merge: 0, create: 0, nextTag: 0 }
  const github = {
    merged: false, queued: false, unreachable: false, tags: new Set<string>(), mergeFails: false, createFails: false, createFailsAfterTagging: false,
  }
  const state = { movedOn: false }
  const save = (patch: Partial<Session>) =>
    Effect.sync(() => {
      if (state.movedOn) return false
      row = { ...row, ...patch }
      return true
    })
  const mergePorts = {
    merge: () =>
      Effect.suspend(() => {
        if (github.unreachable) return fail("IP allow list")
        calls.merge++
        if (github.mergeFails) return fail("not mergeable")
        github.merged = !github.queued
        return Effect.void
      }),
    isMerged: () => (github.unreachable ? fail("IP allow list") : Effect.sync(() => github.merged)),
  }
  const releasePorts = {
    save,
    nextTag: (prefix: string) =>
      Effect.sync(() => {
        calls.nextTag++
        return `${prefix}-v0.6.${github.tags.size + 1}`
      }),
    tagExists: (tag: string) => Effect.sync(() => github.tags.has(tag)),
    create: (tag: string) =>
      Effect.suspend(() => {
        calls.create++
        if (github.createFails) return fail("api down")
        github.tags.add(tag)
        return github.createFailsAfterTagging ? fail("timed out") : Effect.void
      }),
  }
  return { get row() { return row }, calls, github, state, mergePorts, releasePorts }
}

describe("merge gate", () => {
  test("a repeat never merges twice: GitHub is asked first", async () => {
    const w = world(session("awaiting_merge"))
    expect(await Effect.runPromise(mergeOnce(w.row, "u", w.mergePorts))).toBe(true)
    expect(await Effect.runPromise(mergeOnce(w.row, "u", w.mergePorts))).toBe(true)
    expect(w.calls.merge).toBe(1)
  })
  test("queued behind a merge queue: not merged yet", async () => {
    const w = world(session("awaiting_merge"))
    w.github.queued = true
    expect(await Effect.runPromise(mergeOnce(w.row, "u", w.mergePorts))).toBe(false)
    expect(w.calls.merge).toBe(1)
  })
  test("a failed call that did merge is a success", async () => {
    const w = world(session("awaiting_merge"))
    w.github.merged = true
    w.github.mergeFails = true
    expect(await Effect.runPromise(mergeOnce(w.row, "u", w.mergePorts))).toBe(true)
  })
  test("a failed call on a still-open PR leaves the gate as it was, so the user can retry", async () => {
    const w = world(session("awaiting_merge"))
    w.github.mergeFails = true
    const exit = await Effect.runPromiseExit(mergeOnce(w.row, "u", w.mergePorts))
    expect(exit._tag).toBe("Failure")
    w.github.mergeFails = false
    expect(await Effect.runPromise(mergeOnce(w.row, "u", w.mergePorts))).toBe(true)
    expect(w.calls.merge).toBe(2)
  })
  test("GHE refusing the network fails the click and the next one, once it is reachable, merges", async () => {
    const w = world(session("awaiting_merge"))
    w.github.unreachable = true
    expect((await Effect.runPromiseExit(mergeOnce(w.row, "u", w.mergePorts)))._tag).toBe("Failure")
    w.github.unreachable = false
    expect(await Effect.runPromise(mergeOnce(w.row, "u", w.mergePorts))).toBe(true)
    expect(w.calls.merge).toBe(1)
  })
})

describe("release gate", () => {
  test("a repeat never cuts a second tag", async () => {
    const w = world(session("awaiting_release"))
    expect(await Effect.runPromise(releaseOnce(w.row, "admin", w.releasePorts))).toBe("admin-v0.6.1")
    expect(w.row.releaseTag).toBe("admin-v0.6.1")
    // The resolve crashed before recording `released`: same tag, already on origin, no second call.
    expect(await Effect.runPromise(releaseOnce(w.row, "admin", w.releasePorts))).toBe("admin-v0.6.1")
    expect(w.calls).toEqual({ merge: 0, create: 1, nextTag: 1 })
    expect([...w.github.tags]).toEqual(["admin-v0.6.1"])
  })
  test("released sessions do nothing", async () => {
    const w = world(session("deploying", { milestones: { ...NO_MILESTONES, released: true }, releaseTag: "admin-v0.6.1" }))
    expect(await Effect.runPromise(releaseOnce(w.row, "admin", w.releasePorts))).toBeUndefined()
    expect(w.calls.create).toBe(0)
  })
  test("a recorded tag not yet on origin is retried with the same tag", async () => {
    const w = world(session("awaiting_release", { releaseTag: "admin-v0.6.4" }))
    expect(await Effect.runPromise(releaseOnce(w.row, "admin", w.releasePorts))).toBe("admin-v0.6.4")
    expect(w.calls).toEqual({ merge: 0, create: 1, nextTag: 0 })
  })
  test("a timed-out call that did create the tag is a success", async () => {
    const w = world(session("awaiting_release"))
    w.github.createFailsAfterTagging = true
    expect(await Effect.runPromise(releaseOnce(w.row, "admin", w.releasePorts))).toBe("admin-v0.6.1")
  })
  test("nothing is cut when the record cannot be written: the session left the gate", async () => {
    const w = world(session("awaiting_release"))
    w.state.movedOn = true
    const failure = await Effect.runPromise(releaseOnce(w.row, "admin", w.releasePorts).pipe(Effect.flip))
    expect(failure._tag).toBe("Conflict")
    expect(w.calls.create).toBe(0)
  })
  test("a failed call that left no tag clears the record", async () => {
    const w = world(session("awaiting_release"))
    w.github.createFails = true
    expect((await Effect.runPromiseExit(releaseOnce(w.row, "admin", w.releasePorts)))._tag).toBe("Failure")
    expect(w.row.releaseTag).toBeNull()
  })
})

/** GitHub whose `gh pr merge` / `gh release create` wait for `release` to be completed, counting the calls that act. */
const slowGitHub = (release: Deferred.Deferred<void>, options: { readonly createFails?: boolean } = {}) => {
  const calls = { merge: 0, create: 0 }
  const state = { merged: false, tags: ["dispute-v0.4.2"] }
  const github = fakeGitHub({
    viewPr: (url) =>
      Effect.succeed({
        number: 3338, title: "fix", state: state.merged ? "MERGED" : "OPEN", mergedAt: state.merged ? "now" : null, headRefOid: "aaaa111", url,
        reviewDecision: "APPROVED", latestReviews: [], statusCheckRollup: [{ name: "checks", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    mergePr: () => Effect.sync(() => void calls.merge++).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.sync(() => void (state.merged = true)))),
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
    branchHead: () => Effect.succeed("0000000000000000000000000000000000000001"),
    prHead: () => Effect.succeed({ sha: "0000000000000000000000000000000000000001", branch: releasable.branch ?? "" }),
  })
  return { github, calls }
}

const releasable: Session = makeSession("awaiting_release", {
  id: "s_rel", alertId: "C1:rel", prUrl: "https://ghe/pull/3338", activity: "Merged, ready to cut dispute-v0.4.3",
  releasePrefix: "dispute",
  milestones: { diagnosed: true, fixed: true, prOpened: true, critiqued: true, ciGreen: true, merged: true, released: false, deployed: false },
})
const releaseCard: Action = {
  id: "a_rel", kind: "release", title: "Ship", detail: "", primaryLabel: "Cut dispute-v0.4.3", options: [], sessionId: "s_rel", alertId: "C1:rel",
  fingerprint: null, retry: false, url: null, createdAt: "2026-10-01T00:00:00.000Z",
}

const seed = (session: Session, card: Action) =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* store.putAlert(makeAlert({ id: session.alertId, sessionId: session.id }))
    yield* store.putSession(session)
    yield* store.putAction(card)
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
          yield* eventually(store.getSession("s_rel"), (s) => (s?.releaseTag === "dispute-v0.4.3" ? s : undefined))
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

  test("a new release follows its own tracker, not the one of the deploy before its follow-up PR", async () => {
    const release = Deferred.makeUnsafe<void>()
    await Effect.runPromise(Deferred.succeed(release, undefined))
    const { github } = slowGitHub(release)
    const world = makeWorld({ github })
    try {
      const after = await world.runPromise(
        Effect.gen(function* () {
          yield* seed({ ...releasable, tracker: { id: "C0AUKD42N3U:1790930000.000100", applied: "h" } }, releaseCard)
          yield* (yield* Actions).resolve("a_rel", null)
          return yield* (yield* Store).getSession("s_rel")
        }),
      )
      expect(after).toMatchObject({ status: "deploying", releaseTag: "dispute-v0.4.3", deployStage: null, tracker: null })
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
      releasePrefix: "dispute",
      milestones: { diagnosed: true, fixed: true, prOpened: true, critiqued: true, ciGreen: true, merged: false, released: false, deployed: false },
    })
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(mergeable, { ...releaseCard, id: "a_merge", kind: "merge", primaryLabel: "Merge" })
          const store = yield* Store
          const first = yield* (yield* Actions).resolve("a_merge", null).pipe(Effect.forkChild)
          const during = yield* eventually(store.getSession("s_rel"), (s) => (s?.activity !== mergeable.activity ? s : undefined))
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

describe("a card whose session moved on acts on nothing and goes", () => {
  const released = Deferred.makeUnsafe<void>()
  Effect.runSync(Deferred.succeed(released, undefined))

  test("a merge card of a session back at work: no merge, the card goes, the session is left alone", async () => {
    const { github, calls } = slowGitHub(released)
    const world = makeWorld({ github })
    // You messaged the session while it waited to merge: it is running again, on a head the review never passed.
    const running = makeSession("running", { id: "s_rel", alertId: "C1:rel", prUrl: "https://ghe/pull/3338", activity: "Read your message" })
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(running, { ...releaseCard, id: "a_merge", kind: "merge", primaryLabel: "Merge" })
          const failure = yield* (yield* Actions).resolve("a_merge", null).pipe(Effect.flip)
          const store = yield* Store
          return { failure, session: yield* store.getSession("s_rel"), cards: yield* store.listActions() }
        }),
      )
      expect(out.failure._tag).toBe("Conflict")
      expect(out.cards).toEqual([])
      expect(out.session).toMatchObject({ status: "running", activity: "Read your message" })
      expect(calls.merge).toBe(0)
    } finally {
      await world.dispose()
    }
  })

  test("a release card of a session that failed meanwhile: no tag is cut", async () => {
    const { github, calls } = slowGitHub(released)
    const world = makeWorld({ github })
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          yield* seed({ ...releasable, status: "failed" }, releaseCard)
          const failure = yield* (yield* Actions).resolve("a_rel", null).pipe(Effect.flip)
          const store = yield* Store
          return { failure, session: yield* store.getSession("s_rel"), cards: yield* store.listActions() }
        }),
      )
      expect(out.failure._tag).toBe("Conflict")
      expect(out.cards).toEqual([])
      expect(out.session).toMatchObject({ status: "failed", releaseTag: null })
      expect(calls.create).toBe(0)
    } finally {
      await world.dispose()
    }
  })

  test("the release gate itself refuses a session that is not waiting for its release", async () => {
    const { github, calls } = slowGitHub(released)
    const world = makeWorld({ github })
    try {
      const failure = await world.runPromise(
        Effect.gen(function* () {
          yield* seed({ ...releasable, status: "resolved" }, releaseCard)
          return yield* (yield* Shipper).release("s_rel").pipe(Effect.flip)
        }),
      )
      expect(failure._tag).toBe("Conflict")
      expect(calls.create).toBe(0)
    } finally {
      await world.dispose()
    }
  })

  test("a deploy that lands withdraws the hand-off it had stalled into", async () => {
    const { github } = slowGitHub(released)
    const world = makeWorld({ github })
    const stalled = makeSession("waiting", {
      id: "s_rel", alertId: "C1:rel", prUrl: "https://ghe/pull/3338", activity: "No deploy progress for 3h",
      releasePrefix: "dispute",
      releaseTag: "dispute-v0.4.3",
      milestones: { diagnosed: true, fixed: true, prOpened: true, critiqued: true, ciGreen: true, merged: true, released: true, deployed: false },
    })
    const tracker = makeAlert({
      id: "C0AUKD42N3U:9.2",
      fields: { _tag: "release", image: "merkl-dispute", version: "v0.4.3", actor: null, runId: null, runUrl: null, tag: "dispute-v0.4.3", stages: [{ name: "Production", status: "success", detail: "" }] },
    })
    try {
      const out = await world.runPromise(
        Effect.gen(function* () {
          yield* seed(stalled, { ...releaseCard, id: "a_stalled", kind: "review", primaryLabel: "Close session" })
          yield* (yield* Shipper).trackDeploy(tracker)
          const store = yield* Store
          return { session: yield* store.getSession("s_rel"), cards: yield* store.listActions() }
        }),
      )
      expect(out.session).toMatchObject({ status: "resolved", resolution: "deployed dispute-v0.4.3" })
      expect(out.cards).toEqual([])
    } finally {
      await world.dispose()
    }
  })
})
