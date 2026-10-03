import { Context, Effect, Layer } from "effect"
import { Conflict, type DaemonError } from "../domain/errors.ts"
import { type Action, dismissCloses } from "../domain/model.ts"
import { Health } from "../health.ts"
import { Hub } from "../hub.ts"
import { AlertPipeline } from "../pipeline/alerts.ts"
import { SessionRepo } from "../sessions/repo.ts"
import { SessionRunner } from "../sessions/runner.ts"
import { Shipper } from "../ship/shipper.ts"
import { SlackThread } from "../slack/thread.ts"
import { Store } from "../store/store.ts"
import { closeUnresolved, makeHandlers } from "./handlers.ts"
import { makeInFlight } from "./in-flight.ts"
import { ActionQueue } from "./queue.ts"

/** The two buttons on every card. */
export interface ActionsShape {
  /** `Conflict` while the same action (or, for merge and release, the same session's gate) is already resolving. */
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
    const pipeline = yield* AlertPipeline
    const inFlight = yield* makeInFlight(hub.notify)
    const handlers = makeHandlers({
      store,
      repo,
      runner,
      shipper: yield* Shipper,
      thread: yield* SlackThread,
      health: yield* Health,
      investigate: pipeline.investigate,
    })

    const resolve = Effect.fn("Actions.resolve")(function* (id: string, response: string | null) {
      const action = yield* queue.find(id)
      yield* inFlight.exclusively(
        resolveKeys(action),
        Effect.gen(function* () {
          // Read inside the guard: a resolve that just finished may have moved the session on.
          const session = action.sessionId === null ? undefined : yield* repo.get(action.sessionId)
          yield* handlers[action.kind]({ action, session, response })
          yield* queue.remove(id)
        }),
      )
    })

    const dismiss = Effect.fn("Actions.dismiss")(function* (id: string) {
      const action = yield* queue.find(id)
      if ((yield* inFlight.held).has(id)) return yield* new Conflict({ message: "This action is being resolved" })
      if (action.kind === "answer") yield* runner.answer(id, "(The user dismissed the question. Proceed on your best judgement.)")
      yield* queue.remove(id)
      if (action.sessionId === null && action.alertId !== null) {
        yield* store.appendAlertEvent(
          action.alertId,
          action.kind === "escalate" ? "Dismissed by you without opening it" : "Dismissed by you, no agent started",
          "dismissed",
        )
      }
      const session = action.sessionId === null ? undefined : yield* repo.get(action.sessionId)
      if (session !== undefined && dismissCloses(action, session)) yield* closeUnresolved(repo, session.id)
      yield* hub.notify
    })

    return { resolve, dismiss, inFlight: inFlight.held }
  }),
)
