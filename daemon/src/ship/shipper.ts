import { Context, Effect, Layer } from "effect"
import { ActionQueue } from "../actions/queue.ts"
import type { AdapterError, GitHubError } from "../domain/errors.ts"
import type { Alert, Session } from "../domain/model.ts"
import { releaseState } from "../domain/release.ts"
import { Hub } from "../hub.ts"
import { ciFailedPrompt, deployFailedPrompt, reviewChangesPrompt } from "../sessions/prompts.ts"
import { SessionRepo } from "../sessions/repo.ts"
import { SessionRunner } from "../sessions/runner.ts"
import { removeWorktree } from "../sessions/worktree.ts"
import { SlackThread } from "../slack/thread.ts"
import { Store } from "../store/store.ts"
import { mergeOnce, releaseOnce } from "./gates.ts"
import { ciState, GitHub, type PullRequest } from "./github.ts"
import * as Messages from "./messages.ts"
import { reviewRequestText, reviewRoute } from "./review.ts"
import {
  afterMerge,
  ciTransition,
  deployStalled,
  deployTransition,
  type Escalation,
  MAX_CI_ROUNDS,
  mergedResolution,
  needsReviewRequest,
} from "./transitions.ts"

/** PR → CI → review → merge → release → deploy, driven by polling GitHub and reading the release tracker. */
export interface ShipperShape {
  /** One pass over shipping sessions: CI, reviews, merges, stalled deploys. */
  readonly tick: Effect.Effect<void, GitHubError>
  /** A release tracker message changed: moves the sessions shipping that tag. */
  readonly trackDeploy: (alert: Alert) => Effect.Effect<void, GitHubError>
  /** The merge gate: merges at most once, then moves on to the release. */
  readonly merge: (sessionId: string) => Effect.Effect<void, GitHubError>
  /** The release gate: cuts at most one tag for the prefix. */
  readonly release: (sessionId: string, prefix: string) => Effect.Effect<void, GitHubError>
  /** Re-runs a failed workflow run on the agent's recommendation. */
  readonly rerun: (sessionId: string, runId: string) => Effect.Effect<void, GitHubError>
}

export class Shipper extends Context.Service<Shipper, ShipperShape>()("Shipper") {}

export const ShipperLive = Layer.effect(Shipper)(
  Effect.gen(function* () {
    const store = yield* Store
    const hub = yield* Hub
    const repo = yield* SessionRepo
    const queue = yield* ActionQueue
    const runner = yield* SessionRunner
    const thread = yield* SlackThread
    const github = yield* GitHub

    const postFor = (session: Session, text: string) =>
      Effect.gen(function* () {
        const alert = yield* store.getAlert(session.alertId)
        if (alert !== undefined) yield* thread.post(alert, text)
      })

    /** Another round for the agent, or a hand-off once the CI-round budget is spent. */
    const escalate = (session: Session, escalation: Escalation, prompt: string, patch: Partial<Session> = {}) =>
      Effect.gen(function* () {
        if (escalation._tag === "HandOff") {
          const waiting = yield* repo.patch(session.id, { ...patch, status: "waiting", activity: escalation.activity })
          if (waiting !== undefined) yield* queue.handOff(waiting, escalation.title, escalation.detail)
          return
        }
        const delivery = yield* runner.continueWith(session.id, prompt, {
          ...patch,
          phase: escalation.phase,
          ciRounds: escalation.round,
          activity: escalation.activity,
        })
        if (delivery !== "refused") return
        const waiting = yield* repo.patch(session.id, { ...patch, status: "waiting", activity: "Could not resume the agent" })
        if (waiting !== undefined) yield* queue.handOff(waiting, "Agent cannot resume", "Its worktree or agent session is gone, so Bridgetown cannot send it back.")
      })

    /**
     * After the merge: resolve (nothing to ship), hand off (a prefix that cannot
     * be a tag), or offer the release. The merge card goes only once the step
     * that can fail has succeeded, so a failure leaves it (and the next tick
     * retries).
     */
    const onMerged = (sessionId: string) =>
      Effect.gen(function* () {
        const session = yield* repo.get(sessionId)
        if (session === undefined) return
        const step = afterMerge(session)
        const dropMergeCards = queue.removeWhere((a) => a.sessionId === sessionId && a.kind === "merge")
        switch (step._tag) {
          case "NothingToRelease": {
            const merged = { ...session.milestones, merged: true }
            const done = yield* repo.patch(sessionId, {
              status: "resolved",
              phase: "done",
              activity: "Merged, nothing to release",
              resolution: mergedResolution(session.prUrl),
              milestones: merged,
            })
            yield* dropMergeCards
            if (done !== undefined) yield* postFor(done, Messages.merged(session.prUrl))
            return
          }
          case "BadPrefix": {
            const waiting = yield* repo.patch(sessionId, { status: "waiting", activity: "Merged; no valid release prefix", milestones: { ...session.milestones, merged: true } })
            if (waiting !== undefined) {
              yield* queue.handOff(waiting, "Merged, not released", `"${step.prefix}" is not a release tag prefix (like admin or states-exporter). Cut the release yourself if one is needed.`)
            }
            yield* dropMergeCards
            return
          }
          case "Release": {
            const tag = yield* github.nextPatchTag(session.repoPath, step.prefix)
            const ready = yield* repo.patch(sessionId, {
              status: "awaiting_release",
              phase: "deploy",
              activity: `Merged, ready to cut ${tag}`,
              milestones: { ...session.milestones, merged: true },
            })
            if (ready !== undefined && (yield* queue.forSession(sessionId, "release")).length === 0) {
              const first = tag.endsWith("-v0.1.0") ? ` This is the first ${step.prefix} release.` : ""
              yield* queue.put({
                kind: "release",
                title: `Ship ${session.title}`,
                detail: `Merged ${session.prUrl ?? ""}. Cutting ${tag} starts the deploy; approval stays with the reviewers.${first}`,
                primaryLabel: `Cut ${tag}`,
                options: [],
                sessionId,
                alertId: session.alertId,
                payload: tag,
              })
            }
            yield* dropMergeCards
            return
          }
        }
      })

    /** Once CI is green, ask the owning team for a review in the approvals channel, with the Revv walkthrough. */
    const requestReview = (session: Session, pr: PullRequest) =>
      Effect.gen(function* () {
        if (session.prUrl === null) return
        const route = reviewRoute(session.component)
        const alert = yield* store.getAlert(session.alertId)
        const result = yield* thread.postChannel(
          route.channelId,
          reviewRequestText({
            route,
            prUrl: session.prUrl,
            prTitle: pr.title,
            summary: session.diagnosis?.split(". ")[0] ?? session.title,
            alertTitle: alert?.title ?? session.title,
            alertPermalink: alert?.permalink ?? null,
          }),
        )
        const posted = result._tag === "Posted"
        yield* repo.modify(session.id, (current) => ({
          ...current,
          review: {
            channelName: route.channelName,
            permalink: posted ? result.permalink : null,
            handledReviewId: current.review?.handledReviewId ?? null,
            posted,
          },
          activity: posted
            ? `Review requested in #${route.channelName}`
            : result.reason === "dry_run"
              ? "Review request not sent (dry run is on)"
              : `Review request to #${route.channelName} failed; retrying`,
        }))
        if (posted && alert !== undefined) yield* thread.post(alert, Messages.reviewRequested(route.channelName, session.prUrl))
      })

    const checkCi = (sessionId: string) =>
      Effect.gen(function* () {
        const before = yield* repo.get(sessionId)
        if (before === undefined || before.prUrl === null) return
        const pr = yield* github.viewPr(before.prUrl)
        const ci = ciState(pr)
        if (ci._tag === "Green" && before.status === "ci" && needsReviewRequest(before, pr, yield* hub.dryRun)) {
          yield* requestReview(before, pr)
        }
        const session = yield* repo.get(sessionId)
        if (session === undefined || (session.status !== "ci" && session.status !== "awaiting_merge")) return
        const step = ciTransition(session, pr, ci)
        switch (step._tag) {
          case "Merged":
            return yield* onMerged(sessionId)
          case "Closed":
            yield* repo.patch(sessionId, { status: "stopped", activity: "PR closed", resolution: "PR closed without merging" })
            return
          case "Wait":
            if (step.activity !== null) yield* repo.patch(sessionId, { activity: step.activity })
            return
          case "Red":
            return yield* escalate(session, step.escalation, ciFailedPrompt(step.failing, session.ciRounds + 1, MAX_CI_ROUNDS))
          case "ChangesRequested":
            return yield* escalate(session, step.escalation, reviewChangesPrompt(step.review.author.login, step.review.body), {
              review: session.review === null ? null : { ...session.review, handledReviewId: step.review.id },
            })
          case "ReadyToMerge": {
            const ready = yield* repo.patch(sessionId, {
              status: "awaiting_merge",
              activity: step.activity,
              milestones: { ...session.milestones, prOpened: true, ciGreen: true },
            })
            if (ready === undefined || (yield* queue.forSession(sessionId, "merge")).length > 0) return
            yield* queue.put({
              kind: "merge",
              title: `Merge ${pr.title}`,
              detail: `#${pr.number} · ${session.diagnosis ?? session.title}`,
              primaryLabel: "Merge",
              options: [],
              sessionId,
              alertId: session.alertId,
              payload: session.prUrl,
            })
            return
          }
        }
      })

    const finishDeploy = (session: Session, alert: Alert) =>
      Effect.gen(function* () {
        const tag = session.release?.tag ?? ""
        const done = yield* repo.patch(session.id, {
          status: "resolved",
          phase: "done",
          activity: `Deployed ${tag}`.trim(),
          resolution: `deployed ${tag}`.trim(),
          milestones: { ...session.milestones, deployed: true },
          deployStage: { _tag: "Deployed" },
          // Removed below: nothing may resume a turn in it.
          worktree: null,
        })
        if (done === undefined) return
        const origin = yield* store.getAlert(session.alertId)
        yield* thread.post(origin ?? alert, Messages.deployed(tag === "" ? alert.title : tag))
        if (session.worktree !== null) yield* removeWorktree(session.repoPath, session.worktree).pipe(Effect.ignore)
      })

    const trackDeploy = Effect.fn("Shipper.trackDeploy")(function* (alert: Alert) {
      if (alert.fields._tag !== "release" || alert.fields.tag === null) return
      const tag = alert.fields.tag
      const state = releaseState(alert.fields.stages)
      for (const session of yield* store.activeSessions()) {
        if (session.release?.tag !== tag || session.status === "running" || session.status === "preparing") continue
        if (yield* runner.busy(session.id)) continue
        const step = deployTransition(session, state)
        switch (step._tag) {
          case "Unchanged":
            continue
          case "Failed":
            yield* escalate(session, step.escalation, deployFailedPrompt(alert, session.branch ?? "fix-bt"), { deployStage: state })
            continue
          case "Deployed":
            yield* finishDeploy(session, alert)
            continue
          case "Progress":
            yield* repo.patch(session.id, { activity: step.activity, deployStage: state })
            continue
        }
      }
    })

    const tick = Effect.gen(function* () {
      // GHE refusing this network is already shown once; every CI check would only repeat it.
      if ((yield* hub.status).github === "blocked") return
      for (const session of yield* store.activeSessions()) {
        if (yield* runner.busy(session.id)) continue
        if (session.status === "ci" || session.status === "awaiting_merge") {
          yield* checkCi(session.id).pipe(
            Effect.catchTag("GheBlocked", () => hub.patchStatus({ github: "blocked" })),
            Effect.catch((error) => hub.patchStatus({ error: `CI check: ${error.message}` })),
          )
        }
        if (deployStalled(session, Date.now())) {
          const waiting = yield* repo.patch(session.id, { status: "waiting", activity: "No deploy progress for 3h" })
          if (waiting !== undefined) yield* queue.handOff(waiting, "Deploy stalled", `No tracker update for ${session.release?.tag ?? "the release"} in 3 hours.`)
        }
      }
    })

    const merge = Effect.fn("Shipper.merge")(function* (sessionId: string) {
      const session = yield* repo.get(sessionId)
      if (session === undefined || session.prUrl === null) return
      const pr = `#${session.prUrl.split("/").pop() ?? ""}`
      const merged = yield* mergeOnce(session, session.prUrl, {
        // The status line says what is happening while `gh pr merge` runs, and goes back if GitHub said no.
        save: (patch) =>
          repo
            .patch(sessionId, { ...patch, activity: patch.mergeRequestedAt === null ? session.activity : `Merging ${pr}…` })
            .pipe(Effect.asVoid),
        merge: github.mergePr,
        isMerged: (url) => github.viewPr(url).pipe(Effect.map((pr) => pr.mergedAt !== null)),
      })
      if (merged) yield* onMerged(sessionId)
      else yield* repo.patch(sessionId, { activity: "Queued to merge" })
    })

    const release = Effect.fn("Shipper.release")(function* (sessionId: string, prefix: string) {
      const session = yield* repo.get(sessionId)
      if (session === undefined) return
      const notes = [session.diagnosis ?? session.title, "", `Fix: ${session.prUrl ?? "n/a"}`, "", "Shipped via Bridgetown."].join("\n")
      const tag = yield* releaseOnce(session, prefix, {
        save: (patch) =>
          repo
            .patch(sessionId, { ...patch, activity: patch.releaseTag === null || patch.releaseTag === undefined ? session.activity : `Cutting ${patch.releaseTag}…` })
            .pipe(Effect.asVoid),
        nextTag: (p) => github.nextPatchTag(session.repoPath, p),
        tagExists: (t) => github.tagExists(session.repoPath, t),
        create: (t) => github.createRelease(t, notes),
      })
      if (tag === undefined) return
      const deploying = yield* repo.patch(sessionId, {
        status: "deploying",
        phase: "deploy",
        activity: `Released ${tag}, waiting for approval`,
        milestones: { ...session.milestones, released: true },
        release: { image: session.release?.image ?? "", tag, version: tag.slice(tag.lastIndexOf("-v") + 1) },
        deployStage: null,
      })
      if (deploying !== undefined) yield* postFor(deploying, Messages.released(tag))
    })

    const rerun = Effect.fn("Shipper.rerun")(function* (sessionId: string, runId: string) {
      yield* github.rerunFailedJobs(runId)
      const session = yield* repo.get(sessionId)
      if (session === undefined) return
      const alert = yield* store.getAlert(session.alertId)
      const tag = alert?.fields._tag === "release" ? alert.fields.tag : null
      yield* repo.patch(sessionId, {
        status: tag === null ? "closed" : "deploying",
        phase: "deploy",
        activity: "Re-ran failed jobs",
        ...(tag === null ? { resolution: "re-ran failed jobs, outcome not tracked" } : {}),
        release: tag === null ? session.release : { image: "", tag, version: "" },
        deployStage: null,
      })
      if (alert !== undefined) yield* thread.post(alert, Messages.reranJobs)
    })

    return { tick, trackDeploy, merge, release, rerun }
  }),
)
