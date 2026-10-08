import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SlackApiError } from "../../src/domain/errors.ts"
import { Hub } from "../../src/hub.ts"
import { SlackMe } from "../../src/slack/me.ts"
import { fakeSlack } from "../support/fakes.ts"
import { makeWorld } from "../support/world.ts"

const calls = { identity: 0, groups: 0, names: 0 }
const refused = (method: string) => new SlackApiError({ method, code: "fatal_error", message: "fatal_error" })
const base = fakeSlack()
const world = makeWorld({
  slack: {
    ...base,
    identity: () => Effect.suspend(() => (++calls.identity === 1 ? Effect.fail(refused("auth.test")) : base.identity())),
    groupsOf: () => Effect.sync(() => void calls.groups++).pipe(Effect.as([{ id: "S1", handle: "devs" }])),
    userName: (id) => Effect.suspend(() => (++calls.names === 1 ? Effect.fail(refused("users.info")) : Effect.succeed(`name of ${id}`))),
  },
})
afterAll(() => world.dispose())

describe("SlackMe caches", () => {
  test("identity: a failure is reported and retried, a success is kept", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const me = yield* SlackMe
        const groupsBefore = yield* me.groups
        const failed = yield* me.identity.pipe(Effect.flip)
        const status = yield* (yield* Hub).status
        const knownAfterFailure = yield* me.known
        const first = yield* me.identity
        const second = yield* me.identity
        return { groupsBefore, failed: failed._tag, slack: status.slack, knownAfterFailure, same: first === second, known: yield* me.known, recovered: yield* (yield* Hub).status }
      }),
    )
    expect(out).toMatchObject({ groupsBefore: [], failed: "SlackApiError", slack: "error", knownAfterFailure: undefined, same: true, known: { user_id: "UME" }, recovered: { slack: "ok", error: null } })
    expect(calls.identity).toBe(2)
  })

  test("groups are looked up once the identity is known, then cached", async () => {
    const groups = await world.runPromise(SlackMe.use((me) => me.groups.pipe(Effect.andThen(me.groups))))
    expect(groups).toEqual([{ id: "S1", handle: "devs" }])
    expect(calls.groups).toBe(1)
  })

  test("names: a failure falls back to the id and is asked again; a success is kept", async () => {
    const names = await world.runPromise(SlackMe.use((me) => Effect.all([me.nameOf("U2"), me.nameOf("U2"), me.nameOf("U2")])))
    expect(names).toEqual(["U2", "name of U2", "name of U2"])
    expect(calls.names).toBe(2)
  })
})


test("failed group lookups are retried immediately and clear only their own error", async () => {
  let attempts = 0
  const recovering = makeWorld({ slack: fakeSlack({ groupsOf: () => Effect.suspend(() => ++attempts === 1
    ? Effect.fail(refused("usergroups.list"))
    : Effect.succeed([{ id: "S1", handle: "devs" }])) }) })
  try {
    await recovering.runPromise(Effect.gen(function* () {
      const me = yield* SlackMe
      const hub = yield* Hub
      yield* me.identity
      yield* hub.problem("jev", "Jev: HTTP 502")
      expect(yield* me.groups).toEqual([])
      expect((yield* hub.status).error).toContain("Slack user groups:")
      expect(yield* me.groups).toEqual([{ id: "S1", handle: "devs" }])
      expect((yield* hub.status).error).toBe("Jev: HTTP 502")
      expect(yield* me.groups).toEqual([{ id: "S1", handle: "devs" }])
    }))
    expect(attempts).toBe(2)
  } finally { await recovering.dispose() }
})
