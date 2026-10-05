import { Context, Effect, Layer } from "effect"
import { type AdapterError, NotFound } from "../domain/errors.ts"
import { newId, now } from "../domain/ids.ts"
import { type Action, RETRY, type Session } from "../domain/model.ts"
import { Hub } from "../hub.ts"
import { Store } from "../store/store.ts"

export type NewAction = Omit<Action, "id" | "createdAt" | "url"> & { readonly url?: string | null }

/** "Needs you": every card goes in and out through here, so each kind is shaped (and deduped) the same way. */
export interface ActionQueueShape {
  readonly list: Effect.Effect<ReadonlyArray<Action>, AdapterError>
  readonly find: (id: string) => Effect.Effect<Action, AdapterError | NotFound>
  readonly put: (action: NewAction) => Effect.Effect<Action, AdapterError>
  /** A session's cards of one kind. */
  readonly forSession: (sessionId: string, kind: Action["kind"]) => Effect.Effect<ReadonlyArray<Action>, AdapterError>
  /**
   * Hands the session to you: a review card whose primary button closes it. A
   * card with the same title already open for the session is not repeated.
   */
  readonly handOff: (session: Session, title: string, detail: string) => Effect.Effect<void, AdapterError>
  /** A review card whose primary button retries the session. One per session. */
  readonly retryCard: (session: Session, title: string, detail: string) => Effect.Effect<void, AdapterError>
  readonly remove: (id: string) => Effect.Effect<void, AdapterError>
  readonly removeWhere: (predicate: (action: Action) => boolean) => Effect.Effect<void, AdapterError>
}

export class ActionQueue extends Context.Service<ActionQueue, ActionQueueShape>()("ActionQueue") {}

export const ActionQueueLive = Layer.effect(ActionQueue)(
  Effect.gen(function* () {
    const store = yield* Store
    const hub = yield* Hub

    const put = (action: NewAction) =>
      Effect.gen(function* () {
        const stored: Action = { ...action, url: action.url ?? null, id: newId("a"), createdAt: now() }
        yield* store.putAction(stored)
        yield* hub.notify
        return stored
      })

    const removeWhere = (predicate: (action: Action) => boolean) =>
      store.deleteActionsWhere(predicate).pipe(Effect.flatMap((count) => (count > 0 ? hub.notify : Effect.void)))

    const reviewCards = (sessionId: string) =>
      store.listActions().pipe(Effect.map((actions) => actions.filter((a) => a.sessionId === sessionId && a.kind === "review")))

    return {
      list: store.listActions(),
      find: (id) =>
        Effect.gen(function* () {
          const action = (yield* store.listActions()).find((a) => a.id === id)
          if (action === undefined) return yield* new NotFound({ message: "unknown action" })
          return action
        }),
      put,
      forSession: (sessionId, kind) =>
        store.listActions().pipe(Effect.map((actions) => actions.filter((a) => a.sessionId === sessionId && a.kind === kind))),
      handOff: (session, title, detail) =>
        Effect.gen(function* () {
          const fullTitle = `${title} · ${session.title}`
          if ((yield* reviewCards(session.id)).some((a) => a.title === fullTitle)) return
          yield* put({
            kind: "review",
            title: fullTitle,
            detail,
            primaryLabel: "Close session",
            options: [],
            sessionId: session.id,
            alertId: session.alertId,
            payload: null,
          })
        }),
      retryCard: (session, title, detail) =>
        Effect.gen(function* () {
          if ((yield* reviewCards(session.id)).some((a) => a.payload === RETRY)) return
          yield* put({
            kind: "review",
            title: `${title} · ${session.title}`,
            detail,
            primaryLabel: "Retry",
            options: [],
            sessionId: session.id,
            alertId: session.alertId,
            payload: RETRY,
          })
        }),
      remove: (id) => store.deleteAction(id).pipe(Effect.andThen(hub.notify)),
      removeWhere,
    }
  }),
)
