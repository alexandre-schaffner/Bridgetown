import { Effect } from "effect"
import { ActionQueue } from "../actions/queue.ts"
import { wasInterrupted } from "../domain/session.ts"
import { Store } from "../store/store.ts"
import { SessionRepo } from "./repo.ts"

/**
 * A daemon restart drops every in-process SDK query. Sessions that were mid-turn
 * cannot be resumed blindly, so they fail with a retry card (Retry resumes the
 * agent's conversation); the CI, merge and deploy stages are driven by polling
 * and simply carry on. Answer cards go: nobody is waiting on them any more.
 */
export const recoverInterrupted = Effect.gen(function* () {
  const store = yield* Store
  const repo = yield* SessionRepo
  const queue = yield* ActionQueue
  const answers = (yield* store.listActions()).filter((a) => a.kind === "answer")
  for (const session of yield* store.activeSessions()) {
    if (!wasInterrupted(session, answers.some((a) => a.sessionId === session.id))) continue
    const failed = yield* repo.patch(session.id, {
      status: "failed",
      activity: "Interrupted by a daemon restart",
      resolution: "interrupted by a daemon restart",
    })
    if (failed !== undefined) {
      yield* queue.retryCard(failed, "Interrupted", "The daemon restarted while this agent was working. Retry resumes it where it stopped.")
    }
  }
  yield* queue.removeWhere((a) => a.kind === "answer")
})
