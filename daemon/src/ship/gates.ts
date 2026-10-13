import { Effect, Schedule } from "effect"
import { type AdapterError, Conflict, type GitHubError } from "../domain/errors.ts"
import type { Session } from "../domain/session.ts"

/**
 * The two human gates that act on GitHub, made idempotent per session: a
 * repeat (a second click, a resolve retried after a crash or a timeout) never
 * merges or tags twice. The ports keep this free of `gh` so it can be tested.
 */

export interface MergePorts {
  readonly merge: (prUrl: string) => Effect.Effect<void, GitHubError | Conflict>
  readonly isMerged: (prUrl: string) => Effect.Effect<boolean, GitHubError>
  /** A hiccup that asking again gets past (a 5xx, a dropped connection, a base branch that moved under the merge). */
  readonly retryable: (error: GitHubError | Conflict) => boolean
  /** The wait between those attempts. */
  readonly backoff?: Schedule.Schedule<unknown>
}

/** Three more tries over about 3.5 seconds: a hiccup passes, a real refusal is not kept waiting long. */
const MERGE_RETRIES = 3
const MERGE_BACKOFF = Schedule.exponential("500 millis")

/**
 * Asks GitHub to merge unless the PR is merged already. GitHub cannot merge a
 * PR twice, so asking it first is what makes a repeat safe; nothing is recorded
 * before the call, so a call that failed (GHE refusing the network, a PR not
 * mergeable yet) leaves the gate as it was and the next click tries again. A
 * `retryable` failure is tried again here first, each time after asking
 * whether it merged anyway; a read that fails then leaves the merge's own
 * failure to say why. Returns whether the PR is merged now (false: queued
 * behind a merge queue).
 */
export const mergeOnce = Effect.fn("mergeOnce")(function* (session: Session, prUrl: string, ports: MergePorts) {
  const again = { while: ports.retryable, times: MERGE_RETRIES, schedule: ports.backoff ?? MERGE_BACKOFF }
  // Called afresh on every attempt: a port may read GitHub when called, not when run.
  const isMerged = Effect.suspend(() => ports.isMerged(prUrl)).pipe(Effect.retry(again))
  if (session.milestones.merged || (yield* isMerged)) return true
  const ask = Effect.suspend(() => ports.merge(prUrl)).pipe(
    Effect.catch((failure) =>
      isMerged.pipe(
        Effect.orElseSucceed(() => false),
        Effect.flatMap((merged) => (merged ? Effect.succeed("merged" as const) : Effect.fail(failure))),
      ),
    ),
    Effect.retry(again),
  )
  if ((yield* ask) === "merged") return true
  return yield* isMerged
})

export interface ReleasePorts {
  /** Persists a patch onto the session; false when the session moved on and nothing was written. */
  readonly save: (patch: Partial<Session>) => Effect.Effect<boolean, AdapterError>
  readonly nextTag: (prefix: string) => Effect.Effect<string, GitHubError>
  readonly tagExists: (tag: string) => Effect.Effect<boolean, GitHubError>
  readonly create: (tag: string) => Effect.Effect<void, GitHubError>
}

/**
 * Cuts at most one release. The tag is chosen once and recorded before `gh
 * release create`, and nothing is cut unless the record was written; a repeat
 * reuses it and skips the call when the tag is already on origin. A failed call
 * that left no tag clears the record. Returns the tag, or `undefined` when the
 * session was already released.
 */
export const releaseOnce = Effect.fn("releaseOnce")(function* (session: Session, prefix: string, ports: ReleasePorts) {
  if (session.milestones.released) return undefined
  const recorded = session.releaseTag
  const tag = recorded ?? (yield* ports.nextTag(prefix))
  if (recorded === null && !(yield* ports.save({ releaseTag: tag }))) {
    return yield* new Conflict({ message: "The session moved on before its release was cut" })
  }
  if (recorded !== null && (yield* ports.tagExists(tag))) return tag
  const created = yield* ports.create(tag).pipe(Effect.result)
  if (created._tag === "Failure") {
    if (yield* ports.tagExists(tag)) return tag
    yield* ports.save({ releaseTag: null })
    return yield* Effect.fail(created.failure)
  }
  return tag
})
