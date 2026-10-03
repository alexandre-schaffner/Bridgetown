import { Effect, Semaphore } from "effect"

/**
 * One mutex per key, so read-modify-write cycles on the same record never
 * interleave while different records proceed in parallel. Keys are session and
 * alert ids: a few hundred at most over the daemon's life, so they are kept.
 */
export interface KeyedLock {
  readonly withLock: (key: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export const makeKeyedLock = (): KeyedLock => {
  const locks = new Map<string, Semaphore.Semaphore>()
  const lockOf = (key: string): Semaphore.Semaphore => {
    const existing = locks.get(key)
    if (existing !== undefined) return existing
    const created = Semaphore.makeUnsafe(1)
    locks.set(key, created)
    return created
  }
  return { withLock: (key) => (effect) => Effect.suspend(() => lockOf(key).withPermit(effect)) }
}
