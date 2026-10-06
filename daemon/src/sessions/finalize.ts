import type { NewAction } from "../actions/queue.ts"
import type { Alert } from "../domain/alert.ts"
import { passedAt } from "../domain/critique.ts"
import { type HandOff, isOwnBranch, type SentBack, type Session, type SessionStatus, shipStatus } from "../domain/session.ts"
import type { PrHead } from "../ship/github.ts"
import * as Messages from "../ship/messages.ts"
import { prLabel } from "../ship/pr.ts"
import { releasePrefixOf } from "../ship/tags.ts"
import type { SessionResult } from "./output.ts"
import { pushBackPrompt } from "./prompts.ts"

/** Times an agent that hands off without a root cause is sent back before the user sees it. */
const MAX_PUSHBACKS = 1

/** The hand-off card's title when a send-back comes back without a fix. */
const SENT_BACK_TITLES: Readonly<Record<SentBack, string>> = { ci: "CI still red", changes: "Changes requested", deploy: "Deploy failed" }

/** A card the result asks for: a hand-off goes through the queue's dedupe, anything else is put as is. */
export type CardRequest =
  | ({ readonly _tag: "HandOff" } & Pick<HandOff, "title" | "detail">)
  | { readonly _tag: "Card"; readonly action: NewAction }

export interface FinalizeInput {
  readonly session: Session
  /** Its `prUrl` already checked to be a PR on the repo Bridgetown ships (`ownPrUrl`). */
  readonly result: SessionResult
  readonly alert: Alert | undefined
  /** Evidence that the agent pushed its branch. */
  readonly pushed: boolean
  /** Where the PR's head is (the commit the review reads, and its branch); `null` with no PR or no answer from GitHub. */
  readonly head: PrHead | null
  /** Whether pushed fixes go through the adversarial review (the setting). */
  readonly adversarialReview: boolean
}

export interface Finalized {
  readonly patch: Partial<Session>
  readonly cards: ReadonlyArray<CardRequest>
  /** Bridgetown's update in the alert's thread (`SlackThread.postUpdate`, which keeps it out of an inbox item's). */
  readonly post: string | null
  /** Another turn, before anything reaches the user. */
  readonly sendBack: string | null
  /** The result cannot stand: the session fails with this reason. */
  readonly fail: string | null
  /** Status lines for the transcript. */
  readonly notes: ReadonlyArray<string>
  /** A draft PR that goes on to CI without a review: take it out of draft. */
  readonly markReady: string | null
}

/**
 * Turns the agent's structured result into the session's next state and the
 * user's next one-click action. Pure: the runner applies it. Milestones only move
 * on evidence; an agent that hands off without a confirmed root cause is sent
 * back once first; a session with a PR in flight goes back to shipping whatever a
 * side turn concludes, so a "no action" answer to a teammate never resolves an
 * open PR, but a send-back (red CI, requested changes, a failed deploy) answered
 * without a fix is handed to you. A pushed head that no review has passed yet goes
 * to the adversarial review before CI. A PR the agent reports that is not on its own
 * branch (one quoted in a thread, a guess) fails the turn rather than go up for you to
 * merge; one GitHub did not answer about is taken as reported.
 */
export const decideOutcome = ({ session, result, alert, pushed, head, adversarialReview }: FinalizeInput): Finalized => {
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
  const none = { cards: [], post: null, sendBack: null, fail: null, notes, markReady: null }
  if (result.prUrl !== null && result.prUrl !== session.prUrl && head !== null && session.branch !== null && !isOwnBranch(session.branch, head.branch)) {
    return { ...none, patch: verdict, fail: `The agent reported ${prLabel(result.prUrl)}, which is on ${head.branch}, not on its own branch ${session.branch}` }
  }
  const shipping = shipStatus(session)
  /** This head already passed the adversarial review. */
  const passed = passedAt(session.critique, head?.sha ?? null)
  /**
   * A head on its way to CI goes to the adversarial review first, unless the setting is off or it already passed.
   * The agent's summary is its reply to the last round's findings, which the next round reads; only the first turn
   * after a round answers them, so a later side turn (a teammate's follow-up) never replaces that reply. A follow-up
   * PR (`restart`) starts its review afresh: the last pass and findings were on another PR.
   */
  const toReview = (restart: boolean): Partial<Session> | null => {
    const last = restart ? null : session.critique
    if (!adversarialReview || (!restart && passed)) return null
    return {
      status: "critiquing",
      phase: "critique",
      activity: "Waiting for review",
      ...(last === null || last.response !== null ? {} : { critique: { ...last, response: result.summary } }),
    }
  }
  const inbox = alert?.fields._tag === "inbox" ? alert.fields : undefined
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
      ? [card({ kind: "reply", title: `Reply to ${inbox.fromName}`, detail: result.summary, primaryLabel: "Send reply" })]
      : []

  // Bridgetown sent the agent back and it found no fix, or none that ships (a failed deploy is only answered by a
  // follow-up PR: the one it released cannot ship again). The ship flow cannot get past that on its own.
  const sentBack = session.sentBack
  if (sentBack !== null && (result.outcome !== "fix_pr" || (sentBack === "deploy" && (result.prUrl ?? session.prUrl) === session.prUrl))) {
    return {
      ...none,
      cards: [...reply, { _tag: "HandOff", title: SENT_BACK_TITLES[sentBack], detail: result.recommendationDetail ?? result.diagnosis }],
      patch: { ...verdict, status: "waiting", activity: result.summary },
      post: result.outcome === "recommendation" ? Messages.recommendation(result.summary, result.recommendationDetail ?? result.recommendation ?? "") : null,
    }
  }

  if (result.outcome === "fix_pr") {
    const prUrl = result.prUrl ?? (shipping === undefined ? null : session.prUrl)
    if (prUrl === null) return { ...none, cards: reply, patch: verdict, fail: "The agent reported a fix but opened no PR" }
    const newPr = prUrl !== session.prUrl
    // A follow-up PR (after a failed deploy, of its own release or of the re-run it recommended) ships on its own:
    // its own CI, merge and release.
    const restart = newPr && (session.prUrl !== null || session.releaseTag !== null)
    const shipTo: SessionStatus = !newPr && shipping !== undefined ? shipping : "ci"
    const review = shipTo === "ci" ? toReview(restart) : null
    const onward: Partial<Session> = shipTo === "ci" ? { status: "ci", phase: "ci", activity: "Waiting for CI" } : { status: shipTo, activity: result.summary }
    const releasePrefix = shipTo !== "ci" ? session.releasePrefix : (releasePrefixOf(result.releasePrefix) ?? (newPr ? null : session.releasePrefix))
    return {
      ...none,
      cards: reply,
      post: newPr ? Messages.fixPr(prUrl, result.summary) : null,
      patch: {
        ...verdict,
        milestones: {
          ...milestones,
          prOpened: true,
          ...(restart ? { critiqued: false, ciGreen: false, merged: false, released: false, deployed: false } : {}),
          // A review and a CI run hold for the head they read: on any other, they are to come (the ship loop reads CI again).
          ...(shipTo === "ci" && !passed ? { critiqued: false, ciGreen: false } : {}),
        },
        ...(restart ? { mergeRequestedAt: null, releaseTag: null, review: null, deployStage: null, tracker: null, critiqueRounds: 0, critique: null } : {}),
        ...(review ?? onward),
        prUrl,
        releasePrefix,
      },
      markReady: review === null && shipTo === "ci" ? prUrl : null,
    }
  }

  if (shipping !== undefined) {
    // A side turn: the PR's own outcome still stands, so the verdict is left alone. A head no
    // review passed (handed back mid-review, or pushed to without a fix result) is reviewed first.
    // A PR through CI before any review ran (the setting was off) is not pulled back into one by a follow-up.
    // A rebuttal without a push is still the agent's reply to the last findings.
    const review = shipping === "ci" && !(session.critique === null && milestones.ciGreen) ? toReview(false) : null
    if (review !== null) return { ...none, cards: reply, patch: { milestones: { ...milestones, critiqued: false }, ...review } }
    return { ...none, cards: reply, patch: { milestones, status: shipping, activity: result.summary }, markReady: shipping === "ci" ? session.prUrl : null }
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
            ? [card({ kind: "rerun", title: `Re-run failed jobs · ${session.title}`, detail, primaryLabel: "Re-run failed jobs" })]
            : [{ _tag: "HandOff", title: "Recommendation", detail }]
      return {
        ...none,
        patch: waiting,
        cards: [...reply, ...next],
        post: Messages.recommendation(result.summary, result.recommendationDetail ?? result.recommendation ?? ""),
      }
    }
    case "no_action":
      if (result.rootCauseFound) {
        return {
          ...none,
          cards: reply,
          patch: { ...verdict, status: "resolved", phase: "done", activity: result.summary, resolution: "no action needed" },
          post: Messages.noActionNeeded(result.summary),
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
