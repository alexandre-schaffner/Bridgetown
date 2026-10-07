import { Effect } from "effect"

/**
 * What `pick` finds in `read` once it finds anything, read every 5 ms: for work that lands on another fiber (a turn, a
 * review, a gate). Dies after about `ms`, counted in reads, so a test that stops the clock still ends.
 */
export const eventually = <A, B, E, R>(read: Effect.Effect<A, E, R>, pick: (value: A) => B | undefined, ms = 2_000): Effect.Effect<B, E, R> =>
  Effect.gen(function* () {
    for (let reads = 0; reads < ms / 5; reads++) {
      const found = pick(yield* read)
      if (found !== undefined) return found
      yield* Effect.sleep("5 millis")
    }
    return yield* Effect.die(`nothing turned up within ${ms} ms`)
  })
