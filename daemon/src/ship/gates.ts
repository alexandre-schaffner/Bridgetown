import { Effect } from "effect"
import type { AdapterError, GitHubError } from "../domain/errors.ts"
import { now } from "../domain/ids.ts"
import type { Session } from "../domain/model.ts"

/**
 * The two human gates that act on GitHub, made idempotent per session. What is
 * about to happen is recorded on the session before the call; a repeat (a second
 * click, a resolve retried after a crash or a timeout) asks GitHub what happened
 * instead of acting again. The ports keep this free of `gh` so it can be tested.
 */

/** Persists a patch onto the session. */
type Save = (patch: Partial<Session>) => Effect.Effect<void, AdapterError>

export interface MergePorts {
  readonly save: Save
  readonly merge: (prUrl: string) => Effect.Effect<void, GitHubError>
  readonly isMerged: (prUrl: string) => Effect.Effect<boolean, GitHubError>
}

/**
 * Asks GitHub to merge at most once. Returns whether the PR is merged now (false:
 * queued behind checks or a merge queue). Only a PR that is still open after a
 * failed call clears the record, so the user can retry.
 */
export const mergeOnce = Effect.fn("mergeOnce")(function* (session: Session, prUrl: string, ports: MergePorts) {
  if (session.milestones.merged) return true
  if (session.mergeRequestedAt === null) {
    yield* ports.save({ mergeRequestedAt: now() })
    const merged = yield* ports.merge(prUrl).pipe(Effect.result)
    if (merged._tag === "Failure") {
      if (yield* ports.isMerged(prUrl)) return true
      yield* ports.save({ mergeRequestedAt: null })
      return yield* Effect.fail(merged.failure)
    }
  }
  return yield* ports.isMerged(prUrl)
})

export interface ReleasePorts {
  readonly save: Save
  readonly nextTag: (prefix: string) => Effect.Effect<string, GitHubError>
  readonly tagExists: (tag: string) => Effect.Effect<boolean, GitHubError>
  readonly create: (tag: string) => Effect.Effect<void, GitHubError>
}

/**
 * Cuts at most one release. The tag is chosen once and recorded before `gh
 * release create`; a repeat reuses it and skips the call when the tag is already
 * on origin. A failed call that left no tag clears the record. Returns the tag,
 * or `undefined` when the session was already released.
 */
export const releaseOnce = Effect.fn("releaseOnce")(function* (session: Session, prefix: string, ports: ReleasePorts) {
  if (session.milestones.released) return undefined
  const recorded = session.releaseTag
  const tag = recorded ?? (yield* ports.nextTag(prefix))
  if (recorded === null) yield* ports.save({ releaseTag: tag })
  if (recorded !== null && (yield* ports.tagExists(tag))) return tag
  const created = yield* ports.create(tag).pipe(Effect.result)
  if (created._tag === "Failure") {
    if (yield* ports.tagExists(tag)) return tag
    yield* ports.save({ releaseTag: null })
    return yield* Effect.fail(created.failure)
  }
  return tag
})
