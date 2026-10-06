import { Context, Effect, Layer } from "effect"
import { cardStands } from "../domain/action.ts"
import type { AdapterError } from "../domain/errors.ts"
import { now } from "../domain/ids.ts"
import { SESSION_RESUMED_EVENT, sessionEndEvent } from "../domain/progress.ts"
import { isFinished, type Session, type TranscriptKind, withPatch } from "../domain/session.ts"
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
   * `undefined`; otherwise the written row. A write that changes the status takes
   * the session's cards its new state no longer offers (`cardStands`) with it:
   * whatever moved it (a gate, a turn starting, the session ending), a dead card
   * is never left to act.
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
        if (current.status !== next.status) yield* store.deleteActionsWhere((action) => action.sessionId === next.id && !cardStands(action, next))
        // The alert's history says when its session ended (and if it came back), so the app never has to infer it.
        if (!isFinished(current) && isFinished(next)) yield* store.appendAlertEvent(next.alertId, sessionEndEvent(next))
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
