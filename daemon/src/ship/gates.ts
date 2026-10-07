import { Effect } from "effect"
import { type AdapterError, Conflict, type GitHubError } from "../domain/errors.ts"
import type { Session } from "../domain/session.ts"

/**
 * The two human gates that act on GitHub, made idempotent per session: a
 * repeat (a second click, a resolve retried after a crash or a timeout) never
 * merges or tags twice. The ports keep this free of `gh` so it can be tested.
 */

export interface MergePorts {
  readonly merge: (prUrl: string) => Effect.Effect<void, GitHubError>
  readonly isMerged: (prUrl: string) => Effect.Effect<boolean, GitHubError>
}

/**
 * Asks GitHub to merge unless the PR is merged already. GitHub cannot merge a
 * PR twice, so asking it first is what makes a repeat safe; nothing is recorded
 * before the call, so a call that failed (GHE refusing the network, a PR not
 * mergeable yet) leaves the gate as it was and the next click tries again.
 * Returns whether the PR is merged now (false: queued behind a merge queue).
 */
export const mergeOnce = Effect.fn("mergeOnce")(function* (session: Session, prUrl: string, ports: MergePorts) {
  if (session.milestones.merged || (yield* ports.isMerged(prUrl))) return true
  const asked = yield* ports.merge(prUrl).pipe(Effect.result)
  if (asked._tag === "Failure") {
    if (yield* ports.isMerged(prUrl)) return true
    return yield* Effect.fail(asked.failure)
  }
  return yield* ports.isMerged(prUrl)
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
