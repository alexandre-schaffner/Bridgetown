import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { makeKeyedLock } from "../../src/lib/keyed-lock.ts"

describe("keyed lock", () => {
  test("serializes one key and forgets it once every holder is done", async () => {
    const lock = makeKeyedLock()
    let inside = 0
    let most = 0
    const critical = (key: string) =>
      Effect.gen(function* () {
        inside += 1
        most = Math.max(most, inside)
        yield* Effect.sleep("1 millis")
        inside -= 1
      }).pipe(lock.withLock(key))
    await Effect.runPromise(Effect.all([...Array.from({ length: 10 }, () => critical("a")), critical("b")], { concurrency: "unbounded" }))
    expect(most).toBe(2) // "a" never twice at once, "b" alongside it
    expect(lock.size()).toBe(0)
  })

  test("an interrupted waiter does not leave its key behind", async () => {
    const lock = makeKeyedLock()
    const size = await Effect.runPromise(
      Effect.gen(function* () {
        const holder = yield* Effect.never.pipe(lock.withLock("a"), Effect.forkChild)
        const waiter = yield* Effect.void.pipe(lock.withLock("a"), Effect.forkChild)
        yield* Effect.sleep("5 millis")
        yield* Fiber.interrupt(waiter)
        yield* Fiber.interrupt(holder)
        return lock.size()
      }),
    )
    expect(size).toBe(0)
  })
})
