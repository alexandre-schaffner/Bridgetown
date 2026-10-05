import { Effect, Semaphore } from "effect"

/**
 * One mutex per key, so read-modify-write cycles on the same record never
 * interleave while different records proceed in parallel. Keys are session and
 * alert ids (one per Slack message ingested), so a key is forgotten as soon as
 * nobody holds or waits for its lock.
 */
export interface KeyedLock {
  readonly withLock: (key: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Keys currently held or waited on. */
  readonly size: () => number
}

interface Entry {
  readonly semaphore: Semaphore.Semaphore
  users: number
}

export const makeKeyedLock = (): KeyedLock => {
  const locks = new Map<string, Entry>()
  const enter = (key: string) =>
    Effect.sync(() => {
      const entry = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
      entry.users += 1
      locks.set(key, entry)
      return entry
    })
  const leave = (key: string, entry: Entry) =>
    Effect.sync(() => {
      entry.users -= 1
      if (entry.users === 0) locks.delete(key)
    })
  return {
    withLock: (key) => (effect) => Effect.acquireUseRelease(enter(key), (entry) => entry.semaphore.withPermit(effect), (entry) => leave(key, entry)),
    size: () => locks.size,
  }
}
