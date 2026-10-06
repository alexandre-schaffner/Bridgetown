import { Effect } from "effect"
import type { ActionQueueShape } from "../actions/queue.ts"
import type { SessionResult } from "../agent/result.ts"
import type { AdapterError } from "../domain/errors.ts"
import { isFinished, type Session, withPatch } from "../domain/session.ts"
import type { HubShape } from "../hub.ts"
import { firstLine, truncate } from "../lib/text.ts"
import type { GitHubShape } from "../ship/github.ts"
import type { SlackThreadShape } from "../slack/thread.ts"
import type { StoreShape } from "../store/store.ts"
import { decideOutcome, type TurnOutcome } from "./outcome.ts"
import type { SessionRepoShape } from "./repo.ts"

export interface FinishDeps {
  readonly store: StoreShape
  readonly thread: SlackThreadShape
  readonly repo: SessionRepoShape
  readonly queue: ActionQueueShape
  readonly github: GitHubShape
  readonly hub: HubShape
  /** Another turn with this prompt (CI-round budget left after a red PR, etc.). */
  readonly sendBack: (id: string, prompt: string) => Effect.Effect<unknown, AdapterError>
}

/** How a turn's end is applied: `decideOutcome` interpreted onto the session, its cards, Slack and a send-back. */
export const makeFinish = ({ store, thread, repo, queue, github, hub, sendBack }: FinishDeps) => {
  /** Evidence that the agent pushed its branch: the ref exists on origin. */
  const branchPushed = (session: Session) =>
    session.branch === null ? Effect.succeed(false) : github.branchHead(session.repoPath, session.branch).pipe(Effect.map((sha) => sha !== null))
  /** Where the PR's head is, `null` with no PR or no answer. */
  const prHead = (prUrl: string | null) => (prUrl === null ? Effect.succeed(null) : github.prHead(prUrl).pipe(Effect.orElseSucceed(() => null)))

  /** Fails the session with a retry card. A stopped or already finished session is left as it is. */
  const finishFailed = (id: string, reason: string) =>
    Effect.gen(function* () {
      yield* repo.log(id, "error", reason).pipe(Effect.ignore)
      const headline = firstLine(reason)
      const failed = yield* repo.patch(id, { status: "failed", activity: headline, resolution: truncate(headline, 80) })
      if (failed !== undefined) yield* queue.retryCard(failed, "Agent failed", reason)
    })

  const applyCards = (session: Session, decision: TurnOutcome) =>
    Effect.gen(function* () {
      for (const card of decision.cards) {
        if (card._tag === "HandOff") {
          yield* queue.handOff(session, card.title, card.detail)
          continue
        }
        // One draft reply per session: a later turn's draft replaces the earlier one.
        if (card.action.kind === "reply") yield* queue.removeWhere((a) => a.sessionId === session.id && a.kind === "reply")
        yield* queue.put(card.action)
      }
    })

  /** Applies the agent's result as `decideOutcome` decides it. A stopped or already finished session is left as it is. */
  const finish = (id: string, result: SessionResult) =>
    Effect.gen(function* () {
      const before = yield* repo.get(id)
      if (before === undefined || isFinished(before)) return
      const alert = yield* store.getAlert(before.alertId)
      const pushed = yield* branchPushed(before)
      const head = yield* prHead(result.prUrl ?? before.prUrl)
      const { adversarialReview } = yield* hub.settings
      // Decided on the row as it is when written, not on the one read before the slow `git ls-remote`.
      const decided: { value?: TurnOutcome } = {}
      const session = yield* repo.modify(id, (current) => {
        const decision = decideOutcome({ session: current, result, alert, pushed, head, adversarialReview })
        decided.value = decision
        // This turn answered whatever it was sent back for; one that fails is retried with the same question.
        return withPatch(current, decision.fail === null ? { ...decision.patch, sentBack: null } : decision.patch)
      })
      const decision = decided.value
      if (session === undefined || decision === undefined) return
      for (const note of decision.notes) yield* repo.log(id, "status", note)
      yield* applyCards(session, decision)
      if (decision.fail !== null) return yield* finishFailed(id, decision.fail)
      if (decision.markReady !== null) {
        yield* github.markReady(decision.markReady).pipe(
          Effect.catch((error) => repo.log(id, "error", `Could not take the PR out of draft: ${error.message}`).pipe(Effect.ignore)),
        )
      }
      if (decision.sendBack !== null) yield* sendBack(id, decision.sendBack)
      if (decision.post !== null && alert !== undefined) yield* thread.postUpdate(alert, decision.post)
    })

  return { finish, finishFailed }
}
