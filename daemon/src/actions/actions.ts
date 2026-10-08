import { randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { type Action, cardStands, dismissCloses } from "../domain/action.ts"
import { Conflict, type DaemonError } from "../domain/errors.ts"
import type { Session } from "../domain/session.ts"
import { Hub } from "../hub.ts"
import { Intake } from "../intake/intake.ts"
import { Asks } from "../sessions/asks.ts"
import { SessionRepo } from "../sessions/repo.ts"
import { SessionRunner } from "../sessions/runner.ts"
import { Shipper } from "../ship/shipper.ts"
import { SlackThread } from "../slack/thread.ts"
import { Store } from "../store/store.ts"
import { makeHandlers } from "./handlers.ts"
import { makeInFlight } from "./in-flight.ts"
import { ActionQueue } from "./queue.ts"

/** The two buttons on every card. */
export interface ActionsShape {
  /**
   * `Conflict` while the same action (or, for merge and release, the same session's gate) is already resolving, and
   * for a card whose session moved on (`cardStands`): that card acts on nothing and goes.
   */
  readonly resolve: (id: string, response: string | null) => Effect.Effect<void, DaemonError>
  /** `Conflict` while it is being resolved. Records the session closed when `dismissCloses`. */
  readonly dismiss: (id: string) => Effect.Effect<void, DaemonError>
  /** Ids of the actions being resolved right now. */
  readonly inFlight: Effect.Effect<ReadonlySet<string>>
}

export class Actions extends Context.Service<Actions, ActionsShape>()("Actions") {}

/** Merge and release are guarded per session too, so two cards for one session cannot both act. */
const resolveKeys = (action: Action): ReadonlyArray<string> =>
  (action.kind === "merge" || action.kind === "release") && action.sessionId !== null
    ? [action.id, `${action.kind}:${action.sessionId}`]
    : [action.id]

export const ActionsLive = Layer.effect(Actions)(
  Effect.gen(function* () {
    const store = yield* Store
    const hub = yield* Hub
    const queue = yield* ActionQueue
    const repo = yield* SessionRepo
    const runner = yield* SessionRunner
    const asks = yield* Asks
    const inFlight = yield* makeInFlight(hub.notify)
    const handlers = makeHandlers({
      store,
      repo,
      runner,
      shipper: yield* Shipper,
      thread: yield* SlackThread,
      investigate: (yield* Intake).investigate,
    })

    /**
     * Runs `f` on the card holding its in-flight keys. The card and its session are read inside the guard: a resolve
     * that just finished may have removed the card or moved the session on.
     */
    const guarded = <A>(id: string, f: (action: Action, session: Session | undefined) => Effect.Effect<A, DaemonError>) =>
      Effect.gen(function* () {
        const seen = yield* queue.find(id)
        return yield* inFlight.exclusively(
          resolveKeys(seen),
          Effect.gen(function* () {
            const action = yield* queue.find(id)
            return yield* f(action, action.sessionId === null ? undefined : yield* repo.get(action.sessionId))
          }),
        )
      })

    const resolve = Effect.fn("Actions.resolve")(function* (id: string, response: string | null) {
      yield* guarded(id, (action, session) =>
        Effect.gen(function* () {
          if (!cardStands(action, session)) {
            yield* queue.remove(id)
            return yield* new Conflict({ message: "The session has moved on since this card was offered" })
          }
          const attemptId = randomUUID()
          const capture = (result: string, detail?: string) => store.captureMemory("action", `bridgetown:action/${action.id}`, JSON.stringify({ kind: action.kind, title: action.title, response, result, detail }), `${attemptId}:${result}`)
            .pipe(hub.observe("memory-capture"), Effect.ignoreCause)
          yield* capture("attempted")
          yield* handlers[action.kind]({ action, session, response }).pipe(Effect.tapError((error) => capture("failed", error.message)))
          yield* capture(action.kind === "reply" ? "handled" : "completed")
          yield* queue.remove(id)
        }),
      )
    })

    const dismiss = Effect.fn("Actions.dismiss")(function* (id: string) {
      yield* guarded(id, (action, session) =>
        Effect.gen(function* () {
          if (action.kind === "answer") yield* asks.dismiss(id)
          yield* queue.remove(id)
          if (action.sessionId === null && action.alertId !== null) {
            yield* store.appendAlertEvent(
              action.alertId,
              action.kind === "escalate" ? "Dismissed by you without opening it" : "Dismissed by you, no agent started",
              { disposition: "dismissed" },
            )
          }
          if (session !== undefined && dismissCloses(action, session)) yield* runner.close(session.id)
          yield* store.captureMemory("action", `bridgetown:action/${action.id}`, JSON.stringify({ kind: action.kind, title: action.title, result: "dismissed", note: "Dismissal does not establish a general preference or prove resolution." }), `${action.id}:dismissed`)
            .pipe(hub.observe("memory-capture"), Effect.ignoreCause)
          yield* hub.notify
        }),
      )
    })

    return { resolve, dismiss, inFlight: inFlight.held }
  }),
)
