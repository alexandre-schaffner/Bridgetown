import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SlackApiError } from "../src/domain/errors.ts"
import { Hub, problemOf, type StatusPatch } from "../src/hub.ts"
import { SlackThread } from "../src/slack/thread.ts"
import { Store } from "../src/store/store.ts"
import { fakeSlack } from "./support/fakes.ts"
import { makeAlert } from "./support/records.ts"
import { makeWorld } from "./support/world.ts"

describe("status problems", () => {
  const world = makeWorld()
  afterAll(() => world.dispose())
  const error = Hub.use((hub) => hub.status.pipe(Effect.map((s) => s.error)))

  test("each part clears its own problem once it works again; the latest still standing is shown", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const hub = yield* Hub
        yield* hub.problem("post", "Slack post failed: ratelimited")
        yield* hub.problem("jev", "Jev: HTTP 502")
        const both = yield* error
        // The same problem reported again (every poll) is not news: it does not jump ahead.
        yield* hub.problem("post", "Slack post failed: ratelimited")
        const repeated = yield* error
        yield* hub.problem("jev", null)
        const afterJev = yield* error
        yield* hub.problem("post", null)
        return { both, repeated, afterJev, none: yield* error }
      }),
    )
    expect(out).toEqual({ both: "Jev: HTTP 502", repeated: "Jev: HTTP 502", afterJev: "Slack post failed: ratelimited", none: null })
  })

  test("a round's problems read as one line", () => {
    expect(problemOf([])).toBeNull()
    expect(problemOf(["Slack #a: ratelimited"])).toBe("Slack #a: ratelimited")
    expect(problemOf(["Slack #a: ratelimited", "Slack #b: ratelimited", "#c: boom"])).toBe("Slack #a: ratelimited (+2 more)")
  })
})

describe("Slack posts' problem", () => {
  const world = makeWorld({
    env: { forceDryRun: false },
    slack: fakeSlack({ post: () => Effect.fail(new SlackApiError({ method: "chat.postMessage", code: "ratelimited", message: "ratelimited" })) }),
  })
  afterAll(() => world.dispose())

  test("a failed post is shown until posts stop failing; in dry run nothing goes out, so none is", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const hub = yield* Hub
        const thread = yield* SlackThread
        yield* hub.modifySettings((current) => Effect.succeed({ ...current, dryRun: false }))
        const failed = yield* thread.post(makeAlert(), "Merged")
        const shown = (yield* hub.status).error
        yield* hub.modifySettings((current) => Effect.succeed({ ...current, dryRun: true }))
        yield* thread.postChannel("C1", "Review requested")
        return { failed: failed._tag, shown, after: (yield* hub.status).error }
      }),
    )
    expect(out).toEqual({ failed: "NotPosted", shown: "Slack post failed: ratelimited", after: null })
  })
})

describe("patchStatus", () => {
  const world = makeWorld()
  afterAll(() => world.dispose())

  test("concurrent patches keep each other's fields, and paused is stored as it ends in memory", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const hub = yield* Hub
        yield* Effect.all([hub.patchStatus({ paused: true }), hub.patchStatus({ lastPollAt: "2026-10-05T12:00:00.000Z" }), hub.patchStatus({ grafanaMcp: "up" })], {
          concurrency: "unbounded",
        })
        yield* Effect.all([hub.patchStatus({ paused: false }), hub.patchStatus({ paused: true })], { concurrency: "unbounded" })
        const status = yield* hub.status
        return { status, stored: yield* (yield* Store).getKv("paused") }
      }),
    )
    expect(out.status).toMatchObject({ lastPollAt: "2026-10-05T12:00:00.000Z", grafanaMcp: "up" })
    expect(out.stored).toBe(String(out.status.paused))
  })

  test("takes no error, even from a value whose type carries one: only a problem sets it", () => {
    const line: { readonly github?: "ok"; readonly error?: string | null } = { github: "ok", error: "boom" }
    // @ts-expect-error `bun run check` fails here if a patch may carry `error` again.
    const patch: StatusPatch = line
    expect(patch.github).toBe("ok")
  })
})

describe("settings", () => {
  const world = makeWorld()
  afterAll(() => world.dispose())

  test("two changes at once both land: each reads what the other wrote", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const hub = yield* Hub
        // The first change yields before writing, as a request does: without the lock, the second would read the old settings.
        yield* Effect.all(
          [
            hub.modifySettings((current) => Effect.yieldNow.pipe(Effect.as({ ...current, autoStart: false }))),
            hub.modifySettings((current) => Effect.succeed({ ...current, inbox: false })),
          ],
          { concurrency: "unbounded" },
        )
        return yield* hub.settings
      }),
    )
    expect(out).toMatchObject({ autoStart: false, inbox: false })
  })
})
