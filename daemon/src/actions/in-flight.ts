import { Effect, Ref } from "effect"
import { Conflict } from "../domain/errors.ts"

export interface InFlight {
  /** Keys held right now: action ids, plus `merge:<session>` / `release:<session>` gates. */
  readonly held: Effect.Effect<ReadonlySet<string>>
  /** Runs `effect` holding `keys`; if any is already held, the same resolve is under way and this one is a Conflict. */
  readonly exclusively: <A, E, R>(keys: ReadonlyArray<string>, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Conflict, R>
}

/** `changed` runs whenever the held set changes, so the app sees `inFlight` flip. */
export const makeInFlight = (changed: Effect.Effect<void>): Effect.Effect<InFlight> =>
  Effect.gen(function* () {
    const keys = yield* Ref.make<ReadonlySet<string>>(new Set())
    return {
      held: Ref.get(keys),
      exclusively: (wanted, effect) =>
        Effect.gen(function* () {
          const acquired = yield* Ref.modify(keys, (held): readonly [boolean, ReadonlySet<string>] =>
            wanted.some((key) => held.has(key)) ? [false, held] : [true, new Set([...held, ...wanted])],
          )
          if (!acquired) return yield* new Conflict({ message: "This action is already being resolved" })
          const release = Ref.update(keys, (held) => new Set([...held].filter((key) => !wanted.includes(key))))
          yield* changed
          return yield* effect.pipe(Effect.ensuring(release.pipe(Effect.andThen(changed))))
        }),
    }
  })
