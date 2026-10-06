import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { Context, Effect, Layer } from "effect"
import { Environment } from "../config.ts"
import { sweepReviewSandboxes } from "../critique/reviewer.ts"
import { type AdapterError, attempt } from "../domain/errors.ts"
import { isFinished } from "../domain/session.ts"
import { Hub } from "../hub.ts"
import { claudeProjectDir } from "../sessions/agent.ts"
import { SessionRepo } from "../sessions/repo.ts"
import { SessionRunner } from "../sessions/runner.ts"
import { isSessionBranch, Worktrees } from "../sessions/worktree.ts"
import { Store, type SessionRef } from "../store/store.ts"
import { planPrune, type PruneRefs, worktreeDue } from "./retention.ts"

export interface HousekeepingShape {
  /**
   * One round: the worktrees of sessions past their grace (`worktreeDue`), then the rows past
   * retention (`planPrune`) with what their sessions left outside the database, then the
   * database file, then reviews' scratch directories a killed daemon left. A step that fails
   * is logged and the next one still runs.
   */
  readonly run: Effect.Effect<void>
}

/** The one place stored things are deleted for age: worktrees, branches, rows, conversations, review scratch. */
export class Housekeeping extends Context.Service<Housekeeping, HousekeepingShape>()("Housekeeping") {}

export const HousekeepingLive = Layer.effect(Housekeeping)(
  Effect.gen(function* () {
    const store = yield* Store
    const repo = yield* SessionRepo
    const runner = yield* SessionRunner
    const worktrees = yield* Worktrees
    const hub = yield* Hub
    const { claudeConfigDir } = yield* Environment

    const warn = (what: string) => (error: AdapterError) => Effect.logWarning(`Housekeeping: ${what}: ${error.message}`)

    /**
     * Claimed first, so nothing resumes into it: `worktree: null` makes the session refuse messages,
     * and Retry waits for the removal on the path's lock. A failed session keeps its branch for Retry.
     */
    const reclaimWorktree = (ref: SessionRef, nowMs: number) =>
      Effect.gen(function* () {
        if (!isSessionBranch(ref.branch) || !worktreeDue(ref, nowMs)) return
        if (ref.worktree === null && !existsSync(worktrees.path(ref.repoPath, ref.branch))) return
        if (yield* runner.busy(ref.id)) return
        const claimed = yield* repo.modify(
          ref.id,
          (current) => (isFinished(current) && worktreeDue(current, nowMs) ? { ...current, worktree: null } : undefined),
          { evenIfFinished: true, touch: false },
        )
        if (claimed !== undefined) yield* worktrees.remove(ref.repoPath, ref.branch, { deleteBranch: claimed.status !== "failed" })
      }).pipe(Effect.catch(warn(`worktree of ${ref.id}`)))

    /** What a session leaves outside the database: its worktree and branches, and its agent conversation. */
    const releaseSession = (ref: SessionRef) =>
      Effect.gen(function* () {
        if (!isSessionBranch(ref.branch)) return
        yield* worktrees.remove(ref.repoPath, ref.branch, { deleteBranch: true })
        const conversation = claudeProjectDir(claudeConfigDir, worktrees.path(ref.repoPath, ref.branch))
        yield* attempt("fs", "remove conversation", () => rm(conversation, { recursive: true, force: true }))
      })

    const prune = (refs: Omit<PruneRefs, "actions">, nowMs: number) =>
      Effect.gen(function* () {
        const plan = planPrune({ ...refs, actions: yield* store.listActions() }, nowMs)
        if (plan.actionIds.length + plan.sessions.length + plan.alertIds.length === 0) return
        // A session whose storage would not go keeps its row, so the next round tries again.
        const released = yield* Effect.filter(plan.sessions, (ref) =>
          releaseSession(ref).pipe(
            Effect.as(true),
            Effect.catch((error) => warn(`storage of ${ref.id}`)(error).pipe(Effect.as(false))),
          ),
        )
        yield* store.pruneRows({ actionIds: plan.actionIds, sessionIds: released.map((ref) => ref.id), alertIds: plan.alertIds })
        yield* hub.notify
        yield* Effect.logInfo(`Housekeeping: pruned ${plan.alertIds.length} alerts, ${released.length} sessions, ${plan.actionIds.length} cards`)
      })

    return {
      run: Effect.gen(function* () {
        const nowMs = Date.now()
        const refs = yield* store.pruneRefs()
        yield* Effect.forEach(refs.sessions, (ref) => reclaimWorktree(ref, nowMs), { discard: true })
        yield* prune(refs, nowMs).pipe(Effect.catch(warn("rows")))
        yield* store.maintain().pipe(Effect.catch(warn("database")))
        yield* sweepReviewSandboxes(tmpdir(), nowMs).pipe(Effect.catch(warn("review scratch")))
      }).pipe(Effect.catch(warn("refs"))),
    }
  }),
)
