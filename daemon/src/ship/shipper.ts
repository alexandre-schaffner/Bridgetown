import { Context, Effect, Layer } from "effect"
import { ActionQueue } from "../actions/queue.ts"
import type { Alert } from "../domain/alert.ts"
import { Conflict, type GitHubError } from "../domain/errors.ts"
import { now } from "../domain/ids.ts"
import { releaseState } from "../domain/release.ts"
import { type SentBack, type Session, withPatch } from "../domain/session.ts"
import { Hub, problemOf } from "../hub.ts"
import { ciFailedPrompt, deployFailedPrompt, reviewChangesPrompt } from "../sessions/prompts.ts"
import { cannotResume, makeHandOff } from "../sessions/hand-off.ts"
import { SessionRepo } from "../sessions/repo.ts"
import { SessionRunner } from "../sessions/runner.ts"
import { SlackThread } from "../slack/thread.ts"
import { Store } from "../store/store.ts"
import { mergeDetail, releaseDetail } from "./cards.ts"
import { mergeOnce, releaseOnce } from "./gates.ts"
import { prLabel } from "./pr.ts"
import { ciState, GitHub, type PullRequest } from "./github.ts"
import * as Messages from "./messages.ts"
import { reviewRequestText, reviewRoute } from "./review.ts"
import { afterMerge, ciTransition, deployStalled, deployTransition, type Escalation, followsDeploy, MAX_CI_ROUNDS, mergedResolution, needsReviewRequest } from "./transitions.ts"

/** PR → CI → review → merge → release → deploy, driven by polling GitHub and reading the release tracker. */
export interface ShipperShape {
  /** One pass over shipping sessions: CI, reviews, merges, release cards, stalled deploys. */
  readonly tick: Effect.Effect<void, GitHubError>
  /** A release tracker message changed: moves the sessions shipping that tag. */
  readonly trackDeploy: (alert: Alert) => Effect.Effect<void, GitHubError>
  /** The merge gate: merges at most once, then moves on to the release. `Conflict` unless the session is `awaiting_merge`. */
  readonly merge: (sessionId: string) => Effect.Effect<void, GitHubError | Conflict>
  /** The release gate: cuts at most one tag for the session's prefix. `Conflict` unless the session is `awaiting_release` with a prefix. */
  readonly release: (sessionId: string) => Effect.Effect<void, GitHubError | Conflict>
  /** Re-runs the failed workflow run of the session's release alert, on the agent's recommendation. `Conflict` unless the session is `waiting` on it. */
  readonly rerun: (sessionId: string) => Effect.Effect<void, GitHubError | Conflict>
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
    const handOff = makeHandOff(repo, queue)

    const postFor = (session: Session, text: string) =>
      Effect.gen(function* () {
        const alert = yield* store.getAlert(session.alertId)
        if (alert !== undefined) yield* thread.postUpdate(alert, text)
      })

    /**
     * Another round for the agent, or a hand-off once the CI-round budget is spent. `record` (what this step saw, so
     * the next tick does not act on it again) is written first either way, whatever becomes of the turn. The turn
     * carries only itself: its round, and what it is `sentBack` for, which the runner writes once a turn takes the
     * prompt, so the result that answers it is the one that reads it.
     */
    const escalate = (session: Session, escalation: Escalation, prompt: string, sentBack: SentBack, record: Partial<Session>) =>
      Effect.gen(function* () {
        if (escalation._tag === "HandOff") return yield* handOff(session.id, escalation, () => record)
        yield* repo.patch(session.id, record)
        const delivery = yield* runner.continueWith(session.id, prompt, {
          phase: escalation.phase,
          ciRounds: escalation.round,
          activity: escalation.activity,
          sentBack,
        })
        if (delivery === "refused") yield* handOff(session.id, cannotResume("send it back"))
      })

    /** The release gate's card, for the tag the release would cut. */
    const offerRelease = (session: Session, prefix: string, tag: string) =>
      queue.put({
        kind: "release",
        title: `Ship ${session.title}`,
        detail: releaseDetail(session.prUrl, tag, prefix),
        primaryLabel: `Cut ${tag}`,
        options: [],
        sessionId: session.id,
        alertId: session.alertId,
      })

    /**
     * After the merge: resolve (nothing to ship), hand off (a prefix that cannot
     * be a tag), or offer the release. The merge card goes (`SessionRepo`
     * withdraws it as the session leaves `awaiting_merge`) only once the step
     * that can fail has succeeded, so a failure leaves it (and the next tick
     * retries). A merge click and the ship tick can both see the merge; only the
     * first to record it moves the session, so the release is offered once.
     */
    const onMerged = (sessionId: string) =>
      Effect.gen(function* () {
        const session = yield* repo.get(sessionId)
        if (session === undefined || session.milestones.merged) return
        const step = afterMerge(session)
        const merged = (current: Session): Partial<Session> | undefined =>
          current.milestones.merged ? undefined : { milestones: { ...current.milestones, merged: true } }
        const recordMerged = (patch: Partial<Session>) =>
          repo.modify(sessionId, (current) => {
            const first = merged(current)
            return first === undefined ? undefined : withPatch(current, { ...patch, ...first })
          })
        switch (step._tag) {
          case "NothingToRelease": {
            const done = yield* recordMerged({ status: "resolved", phase: "done", activity: "Merged, nothing to release", resolution: mergedResolution(session.prUrl) })
            if (done === undefined) return
            yield* postFor(done, Messages.merged(session.prUrl))
            return
          }
          case "BadPrefix": {
            yield* handOff(
              sessionId,
              {
                activity: "Merged; no valid release prefix",
                title: "Merged, not released",
                detail: `"${step.prefix}" is not a release tag prefix (like admin or states-exporter). Cut the release yourself if one is needed.`,
              },
              merged,
            )
            return
          }
          case "Release": {
            const tag = yield* github.nextPatchTag(session.repoPath, step.prefix)
            const ready = yield* recordMerged({ status: "awaiting_release", phase: "deploy", activity: `Merged, ready to cut ${tag}` })
            if (ready === undefined) return
            yield* offerRelease(ready, step.prefix, tag)
            return
          }
        }
      })

    /** Once CI is green, ask the owning team for a review in the approvals channel, with the Revv walkthrough. */
    const requestReview = (session: Session, pr: PullRequest) =>
      Effect.gen(function* () {
        if (session.prUrl === null) return
        const alert = yield* store.getAlert(session.alertId)
        // The prefix it ships under, else the image its release alert names.
        const route = reviewRoute(session.releasePrefix ?? (alert?.fields._tag === "release" ? alert.fields.image : null))
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
        if (posted && alert !== undefined) yield* thread.postUpdate(alert, Messages.reviewRequested(route.channelName, session.prUrl))
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
        if (session === undefined || session.prUrl === null || (session.status !== "ci" && session.status !== "awaiting_merge")) return
        // Past the review (or with it off) but still a draft: an earlier `gh pr ready` failed, and GitHub won't merge a draft.
        if (pr.isDraft === true && pr.state === "OPEN") yield* github.markReady(session.prUrl)
        const step = ciTransition(session, pr, ci, Date.now())
        // The stepper's CI step is what GitHub says now: green, or not (yet) after a new push or a red run.
        const ciGreen = ci._tag === "Green"
        const milestones = { ...session.milestones, ciGreen }
        switch (step._tag) {
          case "Merged":
            return yield* onMerged(sessionId)
          case "Closed":
            // Someone closed it on GitHub: closed without a fix, not stopped by you.
            yield* repo.patch(sessionId, { status: "closed", activity: "PR closed on GitHub", resolution: "PR closed without merging" })
            return
          case "Wait": {
            const activity = step.activity ?? session.activity
            if (activity !== session.activity || ciGreen !== session.milestones.ciGreen) yield* repo.patch(sessionId, { activity, milestones })
            return
          }
          case "BackToCi":
            yield* repo.patch(sessionId, { status: "ci", activity: step.activity, mergeRequestedAt: null, milestones })
            return
          case "Red":
            return yield* escalate(session, step.escalation, ciFailedPrompt(step.failing, session.ciRounds + 1, MAX_CI_ROUNDS), "ci", { milestones })
          case "ChangesRequested":
            return yield* escalate(session, step.escalation, reviewChangesPrompt(step.review.author.login, step.review.body), "changes", {
              review: session.review === null ? null : { ...session.review, handledReviewId: step.review.id },
              milestones,
            })
          case "ReadyToMerge": {
            // Staying at the gate keeps its card. Arriving there (from CI, or after a merge GitHub took and dropped) puts a fresh one.
            if (session.status === "awaiting_merge" && session.mergeRequestedAt === null && (yield* queue.forSession(sessionId, "merge")).length > 0) return
            // Only onto the row as read: a merge click may just have handed the PR to GitHub.
            const ready = yield* repo.modify(sessionId, (current) =>
              current.updatedAt !== session.updatedAt
                ? undefined
                : withPatch(current, { status: "awaiting_merge", activity: step.activity, mergeRequestedAt: null, milestones: { ...milestones, prOpened: true } }),
            )
            if (ready === undefined) return
            yield* queue.removeWhere((a) => a.sessionId === sessionId && a.kind === "merge")
            yield* queue.put({
              kind: "merge",
              title: `Merge ${pr.title}`,
              detail: mergeDetail(session, pr),
              primaryLabel: "Merge",
              options: [],
              sessionId,
              alertId: session.alertId,
            })
            return
          }
        }
      })

    const finishDeploy = (session: Session, alert: Alert) =>
      Effect.gen(function* () {
        const tag = session.releaseTag ?? ""
        const done = yield* repo.patch(session.id, {
          status: "resolved",
          phase: "done",
          activity: `Deployed ${tag}`.trim(),
          resolution: `deployed ${tag}`.trim(),
          milestones: { ...session.milestones, deployed: true },
          deployStage: { _tag: "Deployed" },
        })
        if (done === undefined) return
        const origin = yield* store.getAlert(session.alertId)
        yield* thread.postUpdate(origin ?? alert, Messages.deployed(tag === "" ? alert.title : tag))
      })

    const trackDeploy = Effect.fn("Shipper.trackDeploy")(function* (alert: Alert) {
      if (alert.fields._tag !== "release" || alert.fields.tag === null) return
      const tag = alert.fields.tag
      const state = releaseState(alert.fields.stages)
      const version = { id: alert.id, applied: (yield* store.alertHash(alert.id)) ?? null }
      // A record of what the session read, not news: it leaves the deploy's quiet clock running (`deployStalled`).
      const note = (session: Session, tracker: Session["tracker"]) =>
        session.tracker?.id === tracker?.id && session.tracker?.applied === tracker?.applied ? Effect.void : repo.patch(session.id, { tracker }, { touch: false })
      for (const session of yield* store.activeSessions()) {
        if (!followsDeploy(session, tag)) continue
        // Busy: the tracker is pointed at but not taken in, so the ship loop applies this version once the turn is over.
        if (yield* runner.busy(session.id)) {
          yield* note(session, session.tracker?.id === alert.id ? session.tracker : { id: alert.id, applied: null })
          continue
        }
        const step = deployTransition(session, state)
        switch (step._tag) {
          case "Unchanged":
            yield* note(session, version)
            continue
          case "Failed":
            yield* escalate(session, step.escalation, deployFailedPrompt(alert, session), "deploy", { deployStage: state, tracker: version })
            continue
          case "Deployed":
            yield* finishDeploy(session, alert)
            continue
          case "Progress":
            yield* repo.patch(session.id, { activity: step.activity, deployStage: state, tracker: version })
            continue
        }
      }
    })

    /** The version of its tracker that came in while the session was busy, applied now that it is not. */
    const catchUp = (session: Session) =>
      Effect.gen(function* () {
        const tracker = session.tracker
        if (tracker === null || session.releaseTag === null || !followsDeploy(session, session.releaseTag)) return
        if ((yield* store.alertHash(tracker.id)) === tracker.applied) return
        const alert = yield* store.getAlert(tracker.id)
        if (alert !== undefined) yield* trackDeploy(alert)
      })

    /**
     * Back at the release gate without its card: a turn in between (your message, a teammate's follow-up) withdrew
     * it, since a card stands only at its own stage (`cardStands`). The gate offers it again, as the merge gate does.
     * Only onto the row as read, so a session that moved on meanwhile gets no card.
     */
    const reofferRelease = (session: Session) =>
      Effect.gen(function* () {
        const step = afterMerge(session)
        if (step._tag !== "Release" || (yield* queue.forSession(session.id, "release")).length > 0) return
        const tag = session.releaseTag ?? (yield* github.nextPatchTag(session.repoPath, step.prefix))
        const back = yield* repo.modify(session.id, (current) =>
          current.updatedAt !== session.updatedAt ? undefined : withPatch(current, { activity: `Merged, ready to cut ${tag}` }),
        )
        if (back !== undefined) yield* offerRelease(back, step.prefix, tag)
      })

    const tick = Effect.gen(function* () {
      // GHE refusing this network is already shown once; every CI check would only repeat it.
      if ((yield* hub.status).github === "blocked") return
      const problems: Array<string> = []
      const reported = (what: string) => <R>(effect: Effect.Effect<void, GitHubError, R>) =>
        effect.pipe(
          Effect.catchTag("GheBlocked", () => hub.patchStatus({ github: "blocked" })),
          Effect.catch((error) => Effect.sync(() => void problems.push(`${what}: ${error.message}`))),
        )
      for (const session of yield* store.activeSessions()) {
        if (yield* runner.busy(session.id)) continue
        if (session.status === "ci" || session.status === "awaiting_merge") yield* checkCi(session.id).pipe(reported("CI check"))
        if (session.status === "awaiting_release") yield* reofferRelease(session).pipe(reported("Release card"))
        yield* catchUp(session).pipe(reported("Deploy tracker"))
        const stalled = deployStalled(session, Date.now())
        if (stalled !== null) yield* handOff(session.id, stalled)
      }
      yield* hub.problem("ci", problemOf(problems))
    })

    /** A write that only lands while the session is still at the gate the click was for. */
    const atGate = (sessionId: string, status: Session["status"], patch: Partial<Session>) =>
      repo.modify(sessionId, (current) => (current.status === status ? withPatch(current, patch) : undefined))

    const movedOn = (gate: string) => new Conflict({ message: `This session is no longer waiting ${gate}` })

    const merge = Effect.fn("Shipper.merge")(function* (sessionId: string) {
      const session = yield* repo.get(sessionId)
      const prUrl = session?.prUrl ?? null
      if (session === undefined || prUrl === null) return yield* movedOn("to merge")
      // The status line says what is happening while `gh pr merge` runs, and goes back if GitHub said no.
      const claimed = yield* atGate(sessionId, "awaiting_merge", { activity: `Merging ${prLabel(prUrl)}…` })
      if (claimed === undefined) return yield* movedOn("to merge")
      const merged = yield* mergeOnce(claimed, prUrl, {
        merge: github.mergePr,
        isMerged: (url) => github.viewPr(url).pipe(Effect.map((pr) => pr.mergedAt !== null)),
      }).pipe(Effect.tapError(() => atGate(sessionId, "awaiting_merge", { activity: session.activity })))
      if (merged) yield* onMerged(sessionId)
      else yield* atGate(sessionId, "awaiting_merge", { mergeRequestedAt: now(), activity: "Queued to merge" })
    })

    const release = Effect.fn("Shipper.release")(function* (sessionId: string) {
      const session = yield* repo.get(sessionId)
      if (session?.status !== "awaiting_release") return yield* movedOn("for its release")
      const step = afterMerge(session)
      if (step._tag !== "Release") return yield* movedOn("for its release")
      const notes = [session.diagnosis ?? session.title, "", `Fix: ${session.prUrl ?? "n/a"}`, "", "Shipped via Bridgetown."].join("\n")
      const tag = yield* releaseOnce(session, step.prefix, {
        save: (patch) =>
          atGate(sessionId, "awaiting_release", {
            ...patch,
            activity: patch.releaseTag === null || patch.releaseTag === undefined ? session.activity : `Cutting ${patch.releaseTag}…`,
          }).pipe(Effect.map((written) => written !== undefined)),
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
        // A new release gets a tracker message of its own: an earlier deploy's (before a follow-up PR) is not followed.
        deployStage: null,
        tracker: null,
      })
      if (deploying !== undefined) yield* postFor(deploying, Messages.released(tag))
    })

    const rerun = Effect.fn("Shipper.rerun")(function* (sessionId: string) {
      const session = yield* repo.get(sessionId)
      if (session?.status !== "waiting") return yield* movedOn("on a re-run")
      const alert = yield* store.getAlert(session.alertId)
      const fields = alert?.fields._tag === "release" ? alert.fields : null
      if (fields?.runId === null || fields?.runId === undefined) return yield* new Conflict({ message: "The alert names no workflow run to re-run" })
      yield* github.rerunFailedJobs(fields.runId)
      const tag = fields.tag
      yield* repo.patch(sessionId, {
        status: tag === null ? "closed" : "deploying",
        phase: "deploy",
        activity: "Re-ran failed jobs",
        ...(tag === null ? { resolution: "re-ran failed jobs, outcome not tracked" } : {}),
        releaseTag: tag ?? session.releaseTag,
        deployStage: null,
        // The tracker as it reads now is the failure being re-run: only an edit after this is news.
        tracker: tag === null ? null : { id: session.alertId, applied: (yield* store.alertHash(session.alertId)) ?? null },
      })
      if (alert !== undefined) yield* thread.postUpdate(alert, Messages.reranJobs)
    })

    return { tick, trackDeploy, merge, release, rerun }
  }),
)
