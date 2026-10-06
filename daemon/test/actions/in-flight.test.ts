import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { makeInFlight } from "../../src/actions/in-flight.ts"
import { AdapterError } from "../../src/domain/errors.ts"

const fail = (message: string) => Effect.fail(new AdapterError({ adapter: "gh", operation: "test", message, cause: null }))

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
