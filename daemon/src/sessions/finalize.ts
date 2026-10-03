import type { NewAction } from "../actions/queue.ts"
import type { Alert, Session, SessionStatus } from "../domain/model.ts"
import * as Messages from "../ship/messages.ts"
import type { SessionResult } from "./output.ts"
import { pushBackPrompt } from "./prompts.ts"

/** Times an agent that hands off without a root cause is sent back before the user sees it. */
export const MAX_PUSHBACKS = 1

/**
 * Where a session with a PR in flight goes back to after a side turn (a
 * teammate's follow-up, your message): the ship flow, which re-checks GitHub
 * and the tracker on its own. `undefined` when nothing is shipping.
 */
export const shipStatus = (session: Session): SessionStatus | undefined => {
  const m = session.milestones
  if (m.released && !m.deployed) return "deploying"
  if (m.merged && !m.released) return session.release === null ? undefined : "awaiting_release"
  if (session.prUrl !== null && !m.merged) return "ci"
  return undefined
}

/** A card the result asks for: a hand-off goes through the queue's dedupe, anything else is put as is. */
export type CardRequest =
  | { readonly _tag: "HandOff"; readonly title: string; readonly detail: string }
  | { readonly _tag: "Card"; readonly action: NewAction }

export interface FinalizeInput {
  readonly session: Session
  /** Its `prUrl` already filtered to an openable URL. */
  readonly result: SessionResult
  readonly alert: Alert | undefined
  /** Evidence that the agent pushed its branch. */
  readonly pushed: boolean
}

export interface Finalized {
  readonly patch: Partial<Session>
  readonly cards: ReadonlyArray<CardRequest>
  /** Posted in the alert's thread. */
  readonly post: string | null
  /** Another turn, before anything reaches the user. */
  readonly sendBack: string | null
  /** The result cannot stand: the session fails with this reason. */
  readonly fail: string | null
  /** Status lines for the transcript. */
  readonly notes: ReadonlyArray<string>
}

/**
 * Turns the agent's structured result into the session's next state and the
 * user's next one-click action. Pure: the runner applies it. Milestones only move
 * on evidence; an agent that hands off without a confirmed root cause is sent
 * back once first; a session with a PR in flight goes back to shipping whatever a
 * side turn concludes, so a "no action" answer to a teammate never resolves an
 * open PR.
 */
export const decideOutcome = ({ session, result, alert, pushed }: FinalizeInput): Finalized => {
  const milestones = {
    ...session.milestones,
    diagnosed: session.milestones.diagnosed || result.rootCauseFound,
    fixed: session.milestones.fixed || pushed,
    prOpened: session.milestones.prOpened || result.prUrl !== null,
  }
  const verdict = {
    diagnosis: result.diagnosis,
    outcome: result.outcome,
    recommendation: result.recommendation,
    rootCauseFound: result.rootCauseFound,
    milestones,
  }
  const notes = result.tried.length > 0 ? [`Tried:\n${result.tried.map((t) => `· ${t}`).join("\n")}`] : []
  const none = { cards: [], post: null, sendBack: null, fail: null, notes }
  const shipping = shipStatus(session)
  const inbox = alert?.fields._tag === "inbox" ? alert.fields : undefined
  const forAlert = (text: string): string | null => (alert === undefined || inbox !== undefined ? null : text)
  const card = (action: Omit<NewAction, "sessionId" | "alertId" | "options">): CardRequest => ({
    _tag: "Card",
    action: { ...action, options: [], sessionId: session.id, alertId: alert?.id ?? session.alertId },
  })

  if (!result.rootCauseFound && result.outcome !== "fix_pr" && session.pushbacks < MAX_PUSHBACKS && shipping === undefined) {
    return {
      ...none,
      patch: { ...verdict, pushbacks: session.pushbacks + 1, activity: "Sent back: no confirmed root cause yet" },
      sendBack: pushBackPrompt(result),
      notes: [...notes, "Bridgetown sent the agent back: it handed off without a confirmed root cause"],
    }
  }

  const reply: ReadonlyArray<CardRequest> =
    inbox !== undefined && result.outcome !== "needs_human"
      ? [card({ kind: "reply", title: `Reply to ${inbox.fromName}`, detail: result.summary, primaryLabel: "Send reply", payload: result.summary })]
      : []

  if (result.outcome === "fix_pr") {
    const prUrl = result.prUrl ?? (shipping === undefined ? null : session.prUrl)
    if (prUrl === null) return { ...none, cards: reply, patch: verdict, fail: "The agent reported a fix but opened no PR" }
    const newPr = prUrl !== session.prUrl
    // A follow-up PR (after a failed deploy) ships on its own: its own CI, merge and release.
    const restart = newPr && session.prUrl !== null
    const status: SessionStatus = !newPr && shipping !== undefined ? shipping : "ci"
    const release =
      status !== "ci"
        ? session.release
        : result.releasePrefix !== null
          ? { image: alert?.fields._tag === "release" ? alert.fields.image : "", tag: result.releasePrefix, version: "" }
          : newPr
            ? null
            : session.release
    return {
      ...none,
      cards: reply,
      post: newPr ? forAlert(Messages.fixPr(prUrl, result.summary)) : null,
      patch: {
        ...verdict,
        milestones: {
          ...milestones,
          prOpened: true,
          ...(restart ? { ciGreen: false, merged: false, released: false, deployed: false } : {}),
        },
        ...(restart ? { mergeRequestedAt: null, releaseTag: null, review: null, deployStage: null } : {}),
        prUrl,
        status,
        phase: status === "ci" ? "ci" : session.phase,
        activity: status === "ci" ? "Waiting for CI" : result.summary,
        component: status === "ci" ? (result.releasePrefix ?? session.component) : session.component,
        release,
      },
    }
  }

  if (shipping !== undefined) {
    // A side turn: the PR's own outcome still stands, so the verdict is left alone.
    return { ...none, cards: reply, patch: { milestones, status: shipping, activity: result.summary } }
  }

  const waiting = { ...verdict, status: "waiting" as const, activity: result.summary }
  switch (result.outcome) {
    case "recommendation": {
      const runId = alert?.fields._tag === "release" ? alert.fields.runId : null
      const detail = result.recommendationDetail ?? result.summary
      const next: ReadonlyArray<CardRequest> =
        inbox !== undefined
          ? []
          : result.recommendation === "rerun_failed_jobs" && runId !== null
            ? [card({ kind: "rerun", title: `Re-run failed jobs · ${session.title}`, detail, primaryLabel: "Re-run failed jobs", payload: runId })]
            : [{ _tag: "HandOff", title: "Recommendation", detail }]
      return {
        ...none,
        patch: waiting,
        cards: [...reply, ...next],
        post: forAlert(Messages.recommendation(result.summary, result.recommendationDetail ?? result.recommendation ?? "")),
      }
    }
    case "no_action":
      if (result.rootCauseFound) {
        return {
          ...none,
          cards: reply,
          patch: { ...verdict, status: "resolved", phase: "done", activity: result.summary, resolution: "no action needed" },
          post: forAlert(Messages.noActionNeeded(result.summary)),
        }
      }
      return {
        ...none,
        patch: waiting,
        cards: [...reply, { _tag: "HandOff", title: "Unverified", detail: `The agent thinks nothing needs doing but could not confirm it. ${result.diagnosis}` }],
      }
    case "needs_human":
      return {
        ...none,
        patch: waiting,
        cards: [
          ...reply,
          {
            _tag: "HandOff",
            title: result.rootCauseFound ? "Needs you" : "Root cause not found",
            detail: result.recommendationDetail ?? result.diagnosis,
          },
        ],
      }
  }
}
