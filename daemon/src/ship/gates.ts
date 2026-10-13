import { Duration, Effect, Schedule } from "effect"
import { AdapterError, Conflict, type GitHubError, type MergeRefused } from "../domain/errors.ts"
import type { Session } from "../domain/session.ts"

/**
 * The two human gates that act on GitHub, made idempotent per session: a
 * repeat (a second click, a resolve retried after a crash or a timeout) never
 * merges or tags twice. The ports keep this free of `gh` so it can be tested.
 */

export interface MergePorts {
  readonly merge: (prUrl: string) => Effect.Effect<void, GitHubError | MergeRefused>
  readonly isMerged: (prUrl: string) => Effect.Effect<boolean, GitHubError>
  /** A hiccup that asking again gets past (a 5xx, a dropped connection, a base branch that moved under the merge). */
  readonly retryable: (error: GitHubError | MergeRefused) => boolean
  /** The wait between those attempts. */
  readonly backoff?: Schedule.Schedule<unknown>
  /** How long the click may take in all, however slowly GitHub answers. */
  readonly deadline?: Duration.Input
}

/** Three more tries 0.5, 1 and 2 seconds apart: a hiccup passes, a real refusal is not kept waiting. */
const MERGE_RETRIES = 3
const MERGE_BACKOFF = Schedule.exponential("500 millis")
/**
 * Each `gh` call may take two minutes before it times out, which is a hiccup too, so tries alone could hold the
 * click for half an hour. Under the app's five minutes, so it still hears why.
 */
const MERGE_DEADLINE: Duration.Input = "4 minutes"

/**
 * Asks GitHub to merge unless the PR is merged already. GitHub cannot merge a
 * PR twice, so asking it first is what makes a repeat safe; nothing is recorded
 * before the call, so a call that failed (GHE refusing the network, a PR not
 * mergeable yet) leaves the gate as it was and the next click tries again. A
 * try that fails `retryable` is tried again, each from that first question, so
 * a merge that went through anyway is not asked twice; a merge that failed
 * is checked once, and a read that fails then leaves the merge's own failure
 * to say why. The whole click gets `deadline`. Returns whether the PR is
 * merged now (false: queued behind a merge queue).
 */
export const mergeOnce = Effect.fn("mergeOnce")(function* (session: Session, prUrl: string, ports: MergePorts) {
  if (session.milestones.merged) return true
  // Called afresh on every try: a port may read GitHub when called, not when run.
  const isMerged = Effect.suspend(() => ports.isMerged(prUrl))
  const attempt = Effect.gen(function* () {
    if (yield* isMerged) return "merged" as const
    const asked = yield* Effect.suspend(() => ports.merge(prUrl)).pipe(Effect.result)
    if (asked._tag === "Success") return "asked" as const
    if (yield* isMerged.pipe(Effect.orElseSucceed(() => false))) return "merged" as const
    return yield* Effect.fail(asked.failure)
  })
  const again = { while: ports.retryable, times: MERGE_RETRIES, schedule: ports.backoff ?? MERGE_BACKOFF }
  // Once GitHub took the merge, only the read is asked again: a queued PR is not merged twice.
  const tried = attempt.pipe(
    Effect.retry(again),
    Effect.flatMap((outcome) => (outcome === "merged" ? Effect.succeed(true) : isMerged.pipe(Effect.retry(again)))),
  )
  const late = new AdapterError({ adapter: "gh", operation: "merge", message: "GitHub did not answer the merge in time. Merge again in a moment.", cause: null })
  return yield* tried.pipe(Effect.timeoutOrElse({ duration: ports.deadline ?? MERGE_DEADLINE, orElse: () => Effect.fail(late) }))
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
