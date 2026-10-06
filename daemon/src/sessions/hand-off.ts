import { Effect } from "effect"
import type { ActionQueueShape } from "../actions/queue.ts"
import { type HandOff, type Session, withPatch } from "../domain/session.ts"
import type { SessionRepoShape } from "./repo.ts"

/** A send-back that could not start a turn: the agent's worktree or SDK session is gone. */
export const cannotResume = (what: string): HandOff => ({
  activity: "Could not resume the agent",
  title: "Agent cannot resume",
  detail: `Its worktree or agent session is gone, so Bridgetown cannot ${what}.`,
})

/**
 * The session waits on you: `waiting` with the hand-off's status line, then its card. `f` sees the row as it is
 * now and returns the rest of the change, or `undefined` to leave the session alone (and post no card).
 */
export const makeHandOff =
  (repo: SessionRepoShape, queue: ActionQueueShape) =>
  (id: string, handOff: HandOff, f: (current: Session) => Partial<Session> | undefined = () => ({})) =>
    Effect.gen(function* () {
      const waiting = yield* repo.modify(id, (current) => {
        const patch = f(current)
        return patch === undefined ? undefined : withPatch(current, { ...patch, status: "waiting", activity: handOff.activity })
      })
      if (waiting !== undefined) yield* queue.handOff(waiting, handOff.title, handOff.detail)
    })
