import { Effect } from "effect"
import type { Action, ActionKind } from "../domain/action.ts"
import type { Alert } from "../domain/alert.ts"
import { type AdapterError, type DaemonError, InvalidInput, NotFound, SlackApiError } from "../domain/errors.ts"
import type { Session } from "../domain/session.ts"
import type { SessionRepoShape } from "../sessions/repo.ts"
import type { SessionRunnerShape } from "../sessions/runner.ts"
import type { ShipperShape } from "../ship/shipper.ts"
import { toMrkdwn } from "../slack/mrkdwn.ts"
import type { SlackThreadShape } from "../slack/thread.ts"
import type { StoreShape } from "../store/store.ts"

/** Recorded when a reply could not go out because dry run is on: closed, not resolved, and says so. */
export const DRY_RUN_REPLY = "dry run · reply not sent"

export interface HandlerDeps {
  readonly store: StoreShape
  readonly repo: SessionRepoShape
  readonly runner: SessionRunnerShape
  readonly shipper: ShipperShape
  readonly thread: SlackThreadShape
  readonly investigate: (alertId: string) => Effect.Effect<void, AdapterError | NotFound>
}

export interface Resolution {
  readonly action: Action
  /** The card's session, read inside the in-flight guard. */
  readonly session: Session | undefined
  readonly response: string | null
}

/**
 * What the primary button of each kind does, once `cardStands` said the card is
 * still live. One exit protocol for all: a handler that succeeds has done its
 * work and the card goes; one that fails leaves the card in place, so the user
 * can try again.
 */
export type Handler = (resolution: Resolution) => Effect.Effect<void, DaemonError>

const alertOf = (store: StoreShape, action: Action) =>
  action.alertId === null ? Effect.succeed<Alert | undefined>(undefined) : store.getAlert(action.alertId)

export const makeHandlers = (deps: HandlerDeps): Readonly<Record<ActionKind, Handler>> => ({
  investigate: ({ action }) => (action.alertId === null ? Effect.void : deps.investigate(action.alertId)),

  escalate: ({ action }) =>
    action.alertId === null ? Effect.void : deps.store.appendAlertEvent(action.alertId, "Opened by you in Slack or Revv", { disposition: "opened" }),

  merge: ({ session }) => (session === undefined ? Effect.void : deps.shipper.merge(session.id)),

  release: ({ session }) => (session === undefined ? Effect.void : deps.shipper.release(session.id)),

  rerun: ({ session }) => (session === undefined ? Effect.void : deps.shipper.rerun(session.id)),

  answer: ({ action, response }) => deps.runner.answer(action.id, response ?? "").pipe(Effect.asVoid),

  reply: ({ action, session, response }) =>
    Effect.gen(function* () {
      // Nothing to send, or nowhere to send it: the card stays, and nothing is recorded as replied.
      const alert = yield* alertOf(deps.store, action)
      if (alert === undefined) return yield* new NotFound({ message: "The message this replies to is gone" })
      // The draft is the card's detail; what you edited it to, the response.
      const text = (response ?? action.detail).trim()
      if (text === "") return yield* new InvalidInput({ message: "The reply is empty" })
      const posted = yield* deps.thread.post(alert, toMrkdwn(text))
      yield* deps.store.captureMemory("action", `bridgetown:action/${action.id}`, JSON.stringify({ kind: "reply", text, result: posted._tag === "Posted" ? "sent" : "not_sent", ...posted }), `${action.id}:post:${posted._tag === "Posted" ? posted.ts : posted.reason}`)
        .pipe(Effect.catch((error) => Effect.logWarning(`Memory capture: ${error.message}`)))
      if (posted._tag === "NotPosted" && posted.reason === "error") {
        return yield* new SlackApiError({ method: "chat.postMessage", code: "not_posted", message: "The reply could not be posted; nothing was sent" })
      }
      if (session === undefined || session.status !== "waiting") return
      const dryRun = posted._tag === "NotPosted" && posted.reason === "dry_run"
      yield* deps.repo.patch(
        session.id,
        dryRun
          ? { status: "closed", activity: "Reply not sent (dry run)", resolution: DRY_RUN_REPLY }
          : {
              status: "resolved",
              phase: "done",
              activity: "Replied",
              resolution: `replied to ${alert.fields._tag === "inbox" ? alert.fields.fromName : "the thread"}`,
            },
      )
    }),

  // A retry card stands only on a failed session, a hand-off only on a waiting one (`cardStands`).
  review: ({ action, session }) =>
    session === undefined
      ? Effect.void
      : action.retry
        ? deps.runner.retry(session.id)
        : deps.runner.close(session.id),
})
