import { Context, Effect, Layer } from "effect"
import { RETRY } from "../actions/queue.ts"
import type { AdapterError } from "../domain/errors.ts"
import { now } from "../domain/ids.ts"
import { type Action, type ActionKind, isFinished, type Session, type TranscriptKind } from "../domain/model.ts"
import { progressOf } from "../domain/progress.ts"
import { Hub } from "../hub.ts"
import { truncate } from "../slack/text.ts"
import { makeKeyedLock } from "../store/keyed-lock.ts"
import { Store } from "../store/store.ts"

export interface ModifyOptions {
  /**
   * Lets `f` see and change a finished session (resolved, closed, failed,
   * stopped). Only the explicit paths pass it: retry, closing a session, your own
   * message to a handed-back session, and cost accounting. Everything else (the
   * runner's status writes, the ship loop, a late SDK event) is refused on a
   * finished session, which is how a stop always wins.
   */
  readonly evenIfFinished?: boolean
  /**
   * Whether the write counts as activity (the default): it bumps `updatedAt`. Housekeeping's don't, so
   * reclaiming a worktree neither reorders the recent sessions nor restarts a retention clock.
   */
  readonly touch?: boolean
}

export interface SessionRepoShape {
  readonly get: (id: string) => Effect.Effect<Session | undefined, AdapterError>
  readonly create: (session: Session) => Effect.Effect<void, AdapterError>
  /**
   * The one way a session changes. Serialized per id; `f` gets the row as it is
   * now, so nothing writes back a snapshot from before a slow call. `undefined`
   * from `f` (or a refused finished session) writes nothing and returns
   * `undefined`; otherwise the written row.
   */
  readonly modify: (
    id: string,
    f: (current: Session) => Session | undefined,
    options?: ModifyOptions,
  ) => Effect.Effect<Session | undefined, AdapterError>
  /** `modify` with a plain patch; `milestones` merge instead of replacing. */
  readonly patch: (id: string, patch: Partial<Session>, options?: ModifyOptions) => Effect.Effect<Session | undefined, AdapterError>
  /** Appends to the transcript; with `activity`, its first line also becomes the status line (subject to the guard). */
  readonly log: (id: string, kind: TranscriptKind, text: string, options?: { readonly activity?: boolean }) => Effect.Effect<void, AdapterError>
}

export class SessionRepo extends Context.Service<SessionRepo, SessionRepoShape>()("SessionRepo") {}

/** The alert history line for a session that just ended, e.g. "Agent session ended · Closed · root cause not found". */
export const sessionEndEvent = (session: Session): string => `Agent session ended · ${progressOf(session).headline}`

export const SESSION_RESUMED_EVENT = "Agent session resumed"

const LIVE_ONLY: ReadonlyArray<ActionKind> = ["merge", "release", "rerun", "answer"]

/**
 * A card that acts on a session still in flight (a merge, a release, a rerun, an answer, a hand-off), so it goes
 * when the session ends. A draft reply still posts, and the retry card is how a failed session goes on.
 */
export const endsWithSession = (action: Action): boolean => LIVE_ONLY.includes(action.kind) || (action.kind === "review" && action.payload !== RETRY)

/** A patch applied to a session; `milestones` merge instead of replacing. */
export const withPatch = (session: Session, patch: Partial<Session>): Session => ({
  ...session,
  ...patch,
  milestones: { ...session.milestones, ...patch.milestones },
})

export const SessionRepoLive = Layer.effect(SessionRepo)(
  Effect.gen(function* () {
    const store = yield* Store
    const hub = yield* Hub
    const locks = makeKeyedLock()

    const modify = (id: string, f: (current: Session) => Session | undefined, options: ModifyOptions = {}) =>
      Effect.gen(function* () {
        const current = yield* store.getSession(id)
        if (current === undefined) return undefined
        if (isFinished(current) && options.evenIfFinished !== true) return undefined
        const changed = f(current)
        if (changed === undefined) return undefined
        const next: Session = { ...changed, id: current.id, updatedAt: options.touch === false ? current.updatedAt : now() }
        yield* store.putSession(next)
        // The alert's history says when its session ended (and if it came back), so the app never has to infer it.
        if (!isFinished(current) && isFinished(next)) {
          yield* store.appendAlertEvent(next.alertId, sessionEndEvent(next))
          yield* store.deleteActionsWhere((action) => action.sessionId === next.id && endsWithSession(action))
        }
        if (isFinished(current) && !isFinished(next)) yield* store.appendAlertEvent(next.alertId, SESSION_RESUMED_EVENT)
        yield* hub.notify
        return next
      }).pipe(locks.withLock(id))

    const patch = (id: string, patch: Partial<Session>, options?: ModifyOptions) => modify(id, (current) => withPatch(current, patch), options)

    return {
      get: store.getSession,
      create: (session) => store.putSession(session).pipe(Effect.andThen(hub.notify)),
      modify,
      patch,
      log: (id, kind, text, options) =>
        Effect.gen(function* () {
          yield* store.appendTranscript(id, { at: now(), kind, text: truncate(text, 4_000) })
          if (options?.activity === true) yield* patch(id, { activity: truncate(text.split("\n")[0] ?? text, 140) })
        }),
    }
  }),
)
