import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { makeInFlight } from "../src/actions/in-flight.ts"
import { AdapterError } from "../src/domain/errors.ts"
import { acceptsMessages, type Action, cardStands, closedResolution, dismissCloses, NO_MILESTONES, openableUrl, type Session, type SessionStatus } from "../src/domain/model.ts"
import { mergeOnce, releaseOnce } from "../src/ship/gates.ts"
import { makeSession } from "./fixtures/records.ts"

const session = (status: SessionStatus, overrides: Partial<Session> = {}): Session =>
  makeSession(status, { prUrl: "https://ghe/pull/1", claudeSessionId: "c", ...overrides })

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

describe("in-flight resolves", () => {
  test("a second resolve of the same action is a Conflict; the key frees when the first ends", async () => {
    const program = Effect.gen(function* () {
      const inFlight = yield* makeInFlight(Effect.void)
      const gate = yield* Deferred.make<void>()
      const first = yield* inFlight.exclusively(["a_1", "merge:s"], Deferred.await(gate)).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const held = yield* inFlight.held
      const same = yield* inFlight.exclusively(["a_1"], Effect.succeed("again")).pipe(Effect.flip)
      // Another card for the same session's merge is the same gate.
      const sameGate = yield* inFlight.exclusively(["a_2", "merge:s"], Effect.succeed("other")).pipe(Effect.flip)
      const unrelated = yield* inFlight.exclusively(["a_3"], Effect.succeed("ok"))
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      const after = yield* inFlight.exclusively(["a_1"], Effect.succeed("free"))
      return { held: [...held], same: same._tag, sameGate: sameGate._tag, unrelated, after, end: [...(yield* inFlight.held)] }
    })
    expect(await Effect.runPromise(program)).toEqual({
      held: ["a_1", "merge:s"],
      same: "Conflict",
      sameGate: "Conflict",
      unrelated: "ok",
      after: "free",
      end: [],
    })
  })
  test("a failed resolve frees its key too", async () => {
    const program = Effect.gen(function* () {
      const inFlight = yield* makeInFlight(Effect.void)
      yield* inFlight.exclusively(["a_1"], fail("boom")).pipe(Effect.ignore)
      return [...(yield* inFlight.held)]
    })
    expect(await Effect.runPromise(program)).toEqual([])
  })
})

describe("contract rules", () => {
  const action = (kind: Action["kind"], retry = false): Action => ({
    id: "a", kind, title: "", detail: "", primaryLabel: "", options: [], sessionId: "s", alertId: null, fingerprint: null, retry, url: null, createdAt: "",
  })
  test("acceptsMessages: live or handed back with a worktree and an agent session", () => {
    expect(acceptsMessages(session("running", { claudeSessionId: null }))).toBe(true)
    expect(acceptsMessages(session("waiting"))).toBe(true)
    expect(acceptsMessages(session("ci"))).toBe(true)
    expect(acceptsMessages(session("failed"))).toBe(true)
    expect(acceptsMessages(session("closed"))).toBe(true)
    expect(acceptsMessages(session("queued"))).toBe(false)
    expect(acceptsMessages(session("preparing"))).toBe(false)
    expect(acceptsMessages(session("resolved"))).toBe(false)
    expect(acceptsMessages(session("waiting", { worktree: null }))).toBe(false)
    expect(acceptsMessages(session("failed", { claudeSessionId: null }))).toBe(false)
  })
  test("dismissCloses: a stranded session's last card", () => {
    expect(dismissCloses(action("review"), session("waiting"))).toBe(true)
    expect(dismissCloses(action("release"), session("awaiting_release"))).toBe(true)
    expect(dismissCloses(action("review", true), session("failed"))).toBe(true)
    expect(dismissCloses(action("answer"), session("waiting"))).toBe(false)
    expect(dismissCloses(action("review"), session("running"))).toBe(false)
    expect(dismissCloses(action("investigate"), undefined)).toBe(false)
  })
  test("dismissCloses: a dead card closes nothing", () => {
    // A merge card left over from before the session was handed back, and an old hand-off on a session that then failed.
    expect(dismissCloses(action("merge"), session("waiting"))).toBe(false)
    expect(dismissCloses(action("review"), session("failed"))).toBe(false)
  })
  test("cardStands: a card stands only at the stage it was offered for", () => {
    const rows: ReadonlyArray<readonly [Action, SessionStatus, boolean]> = [
      [action("merge"), "awaiting_merge", true],
      [action("merge"), "running", false],
      [action("merge"), "closed", false],
      [action("release"), "awaiting_release", true],
      [action("release"), "failed", false],
      [action("rerun"), "waiting", true],
      [action("rerun"), "deploying", false],
      [action("review"), "waiting", true],
      [action("review"), "running", false],
      [action("review"), "resolved", false],
      [action("review", true), "failed", true],
      [action("review", true), "queued", false],
      [action("reply"), "resolved", true],
      [action("answer"), "running", true],
    ]
    for (const [card, status, stands] of rows) expect([card.kind, status, cardStands(card, session(status))]).toEqual([card.kind, status, stands])
    expect(cardStands(action("merge"), undefined)).toBe(false)
    expect(cardStands({ ...action("investigate"), sessionId: null }, undefined)).toBe(true)
  })
  test("L3: dismissing the merge card of a session waiting to merge closes it", () => {
    expect(dismissCloses(action("merge"), session("awaiting_merge"))).toBe(true)
    expect(dismissCloses(action("merge"), session("ci"))).toBe(false)
  })
  test("closing without a fix says how far it got, never 'resolved'", () => {
    expect(closedResolution(session("failed"))).toBe("agent failed")
    expect(closedResolution(session("waiting", { rootCauseFound: false }))).toBe("root cause not found")
    expect(closedResolution(session("waiting", { outcome: "recommendation" }))).toBe("recommendation handed to you")
    expect(closedResolution(session("awaiting_release", { milestones: { ...NO_MILESTONES, merged: true } }))).toBe("merged, not released")
    expect(closedResolution(session("awaiting_merge", { milestones: { ...NO_MILESTONES, prOpened: true } }))).toBe("PR open, not merged")
    expect(closedResolution(session("waiting"))).toBe("not fixed")
  })
  test("only https, slack and revv links get through", () => {
    expect(openableUrl("https://nocturlab.ghe.com/Merkl/monorepo/pull/1")).toBe("https://nocturlab.ghe.com/Merkl/monorepo/pull/1")
    expect(openableUrl("revv://pr?host=x&repo=y&number=1")).toBe("revv://pr?host=x&repo=y&number=1")
    expect(openableUrl("slack://channel?id=C1")).toBe("slack://channel?id=C1")
    expect(openableUrl("file:///etc/passwd")).toBeNull()
    expect(openableUrl("javascript:alert(1)")).toBeNull()
    expect(openableUrl("http://example.com")).toBeNull()
    expect(openableUrl("not a url")).toBeNull()
    expect(openableUrl(null)).toBeNull()
  })
})
