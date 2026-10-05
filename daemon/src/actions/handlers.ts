import { Effect } from "effect"
import { type AdapterError, type DaemonError, type NotFound, SlackApiError } from "../domain/errors.ts"
import type { Action, ActionKind, Alert, Session } from "../domain/model.ts"
import type { SessionRepoShape } from "../sessions/repo.ts"
import type { SessionRunnerShape } from "../sessions/runner.ts"
import type { ShipperShape } from "../ship/shipper.ts"
import { tagPrefix } from "../ship/transitions.ts"
import { toMrkdwn } from "../slack/text.ts"
import type { SlackThreadShape } from "../slack/thread.ts"
import type { StoreShape } from "../store/store.ts"
import { RETRY } from "./queue.ts"

/** The honest one-line outcome of a session you close without a verified fix. Never "resolved". */
export const closedResolution = (session: Session): string =>
  session.status === "failed"
    ? "agent failed"
    : session.rootCauseFound === false
      ? "root cause not found"
      : session.outcome === "recommendation"
        ? "recommendation handed to you"
        : session.milestones.merged
          ? "merged, not released"
          : session.milestones.prOpened
            ? "PR open, not merged"
            : "not fixed"

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
 * What the primary button of each kind does. One exit protocol for all: a
 * handler that succeeds has done its work and the card goes; one that fails
 * leaves the card in place, so the user can try again.
 */
export type Handler = (resolution: Resolution) => Effect.Effect<void, DaemonError>

/** Closing without a verified outcome: recorded as closed, never as resolved. */
export const closeUnresolved = (repo: SessionRepoShape, sessionId: string) =>
  repo.modify(
    sessionId,
    (current) =>
      current.status === "resolved" || current.status === "closed" || current.status === "stopped"
        ? undefined
        : { ...current, status: "closed", activity: "Closed by you", resolution: closedResolution(current) },
    { evenIfFinished: true },
  )

const alertOf = (store: StoreShape, action: Action) =>
  action.alertId === null ? Effect.succeed<Alert | undefined>(undefined) : store.getAlert(action.alertId)

export const makeHandlers = (deps: HandlerDeps): Readonly<Record<ActionKind, Handler>> => ({
  investigate: ({ action }) => (action.alertId === null ? Effect.void : deps.investigate(action.alertId)),

  escalate: ({ action }) =>
    action.alertId === null ? Effect.void : deps.store.appendAlertEvent(action.alertId, "Opened by you in Slack or Revv", "opened"),

  merge: ({ session }) => (session === undefined ? Effect.void : deps.shipper.merge(session.id)),

  release: ({ action, session }) =>
    session === undefined || action.payload === null ? Effect.void : deps.shipper.release(session.id, tagPrefix(action.payload)),

  rerun: ({ action, session }) =>
    session === undefined || action.payload === null ? Effect.void : deps.shipper.rerun(session.id, action.payload),

  answer: ({ action, response }) => deps.runner.answer(action.id, response ?? "").pipe(Effect.asVoid),

  reply: ({ action, session, response }) =>
    Effect.gen(function* () {
      const alert = yield* alertOf(deps.store, action)
      const text = (response ?? action.payload ?? "").trim()
      const posted = alert === undefined || text === "" ? undefined : yield* deps.thread.post(alert, toMrkdwn(text))
      // A failed post keeps the card: nothing went out, so nothing is recorded.
      if (posted?._tag === "NotPosted" && posted.reason === "error") {
        return yield* new SlackApiError({ method: "chat.postMessage", code: "not_posted", message: "The reply could not be posted; nothing was sent" })
      }
      if (session === undefined || session.status !== "waiting") return
      const dryRun = posted?._tag === "NotPosted" && posted.reason === "dry_run"
      yield* deps.repo.patch(
        session.id,
        dryRun
          ? { status: "closed", activity: "Reply not sent (dry run)", resolution: DRY_RUN_REPLY }
          : {
              status: "resolved",
              phase: "done",
              activity: "Replied",
              resolution: `replied to ${alert?.fields._tag === "inbox" ? alert.fields.fromName : "the thread"}`,
            },
      )
    }),

  review: ({ action, session }) =>
    Effect.gen(function* () {
      if (session === undefined) return
      if (session.status === "failed" && action.payload === RETRY) return yield* deps.runner.retry(session.id)
      if (session.status === "waiting" || session.status === "failed") yield* closeUnresolved(deps.repo, session.id)
    }),
})
