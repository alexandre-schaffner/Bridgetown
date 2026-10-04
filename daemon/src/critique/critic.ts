import { Context, Effect, FiberMap, Layer } from "effect"
import { ActionQueue } from "../actions/queue.ts"
import { type AdapterError, errorMessage } from "../domain/errors.ts"
import { type Alert, type Critique, critiquePassed, type Finding, findingsUnanswered, passedAt, REVIEWER_NAMES, reviewFindingOf, type Session } from "../domain/model.ts"
import { Hub } from "../hub.ts"
import { run } from "../proc.ts"
import { cannotResume, type HandOff, makeHandOff } from "../sessions/hand-off.ts"
import { SessionRepo } from "../sessions/repo.ts"
import { SessionRunner } from "../sessions/runner.ts"
import { GitHub } from "../ship/github.ts"
import { Store } from "../store/store.ts"
import { Jev } from "../triage/jev.ts"
import { decideFinding, reviewerFor } from "../triage/policy.ts"
import { critiqueFailedPrompt, critiquePrompt } from "./prompts.ts"
import { Reviewer, type Verdict } from "./reviewer.ts"
import { critiqueStep, findingLine, fixingActivity, MAX_CRITIQUE_ROUNDS, reviewErrorStep } from "./transitions.ts"

/** The adversarial review between a pushed fix and CI: another vendor's model reviews, Jev drops the nitpicks, the agent fixes the rest. */
export interface CriticShape {
  /** Starts a review for every `reviewing` session that has none running. */
  readonly tick: Effect.Effect<void, AdapterError>
}

export class Critic extends Context.Service<Critic, CriticShape>()("Critic") {}

/** Jev calls in flight for one review. */
const JUDGE_CONCURRENCY = 4

export const CriticLive = Layer.effect(Critic)(
  Effect.gen(function* () {
    const store = yield* Store
    const hub = yield* Hub
    const repo = yield* SessionRepo
    const queue = yield* ActionQueue
    const runner = yield* SessionRunner
    const github = yield* GitHub
    const reviewer = yield* Reviewer
    const jev = yield* Jev

    /** One review per session at a time; interrupted with the layer. */
    const reviews = yield* FiberMap.make<string>()
    /** Reviews in a row that could not run, per session. A restart starts the count again. */
    const errors = new Map<string, number>()

    /**
     * Writes only while the session is still in review. With `since` (the row the review started from), also only
     * if no turn ran in between: a turn records a new round or the agent's reply, which the result never read.
     */
    const inReview = (current: Session, since?: Session): boolean =>
      current.status === "critiquing" &&
      (since === undefined || (current.critiqueRounds === since.critiqueRounds && (current.critique?.response ?? null) === (since.critique?.response ?? null)))

    const stillReviewing = (id: string, f: (current: Session) => Session, since?: Session) =>
      repo.modify(id, (current) => (inReview(current, since) ? f(current) : undefined))

    const handOffSession = makeHandOff(repo, queue)
    const handOff = (id: string, critique: Critique | null, step: HandOff, since?: Session) =>
      handOffSession(id, step, (current) => (inReview(current, since) ? { critique: critique ?? current.critique } : undefined))

    /** Out of draft and on to CI. A failed `gh pr ready` is not a review that could not run: only this step is retried. */
    const toCi = (session: Session, note: string, critiqued: boolean) =>
      Effect.gen(function* () {
        if (session.prUrl === null) return
        const marked = yield* github.markReady(session.prUrl).pipe(
          Effect.as(true),
          Effect.catchTag("AdapterError", (error) => onError(session.id, error.message, "Could not take the PR out of draft").pipe(Effect.as(false))),
        )
        if (!marked) return
        const shipped = yield* stillReviewing(session.id, (current) => ({
          ...current,
          status: "ci",
          phase: "ci",
          activity: "Waiting for CI",
          milestones: { ...current.milestones, critiqued },
        }))
        if (shipped !== undefined) yield* repo.log(session.id, "status", note)
      })

    /** The review passed: recorded first, so a failed `gh pr ready` is retried on the next pass without reviewing again. */
    const ready = (session: Session, critique: Critique) =>
      Effect.gen(function* () {
        if (session.critique !== critique && (yield* stillReviewing(session.id, (current) => ({ ...current, critique }), session)) === undefined) return
        yield* toCi(session, "Review passed; the PR is out of draft", true)
      })

    /** Jev's verdict on each finding, through the thresholds. Without Jev every finding blocks: never laxer than the reviewer. */
    const judge = (session: Session, worktree: string, findings: Verdict["findings"], previous: Critique | null) =>
      Effect.gen(function* () {
        const thresholds = (yield* hub.settings).thresholds
        const previousRound =
          previous === null ? null : { findings: previous.findings.filter((f) => f.blocks).map(reviewFindingOf), reply: previous.response ?? "(no reply)" }
        return yield* Effect.forEach(
          findings,
          (finding) =>
            Effect.gen(function* () {
              const diff = yield* run(["git", "diff", "origin/main...HEAD", "--", finding.file], { cwd: worktree, timeoutMs: 30_000 }).pipe(
                Effect.map((result) => result.stdout),
                Effect.orElseSucceed(() => ""),
              )
              const judged = yield* jev
                .judgeFinding({ change: { title: session.title, diagnosis: session.diagnosis }, finding: reviewFindingOf(finding), diff, previousRound })
                .pipe(
                  Effect.map((verdict) => ({ jev: verdict, ...decideFinding(verdict, thresholds) })),
                  Effect.catch((error) => Effect.succeed({ jev: null, blocks: true, reason: `Jev unavailable: not filtered (${error.message})` })),
                )
              return { finding: { ...reviewFindingOf(finding), jev: judged.jev, blocks: judged.blocks } satisfies Finding, reason: judged.reason }
            }),
          { concurrency: JUDGE_CONCURRENCY },
        )
      })

    const review = (id: string) =>
      Effect.gen(function* () {
        const session = yield* repo.get(id)
        if (session === undefined || session.status !== "critiquing" || session.worktree === null || session.prUrl === null) return
        const prUrl = session.prUrl
        const head = yield* github.prHead(prUrl)
        if (head === null) return yield* onError(id, `GitHub reports no head commit for ${prUrl}`)
        if (session.critique !== null && passedAt(session.critique, head)) return yield* ready(session, session.critique)
        // This head's findings were recorded but never reached the agent (its turn was parked for a slot when the
        // daemon stopped): deliver them rather than review the same head again and spend another round.
        if (session.critique !== null && session.critique.sha === head && findingsUnanswered(session.critique)) {
          return yield* deliverFindings(id, session.critique, session.critiqueRounds)
        }

        const alert: Alert | undefined = yield* store.getAlert(session.alertId)
        const profile = reviewerFor(alert?.triage.jev?.depth ?? "standard")
        const round = session.critiqueRounds + 1
        const previous = session.critique !== null && !critiquePassed(session.critique) ? session.critique : null
        const name = REVIEWER_NAMES[profile.vendor]
        yield* repo.log(id, "status", `${name} reviewing ${head.slice(0, 7)} (round ${round})…`, { activity: true })
        const verdict = yield* reviewer.review({
          worktree: session.worktree,
          head,
          profile,
          prompt: critiquePrompt({ alert, session, round, previous: previous === null ? null : { findings: previous.findings.filter((f) => f.blocks), reply: previous.response } }),
        })
        const judged = yield* judge(session, session.worktree, verdict.findings, previous)
        const findings = judged.map((j) => j.finding)
        const blocking = findings.filter((f) => f.blocks)
        yield* repo.log(
          id,
          "status",
          [
            `${name} review, round ${round}: ${blocking.length === 0 ? "passed" : `${blocking.length} blocking`}${judged.length > blocking.length ? `, ${judged.length - blocking.length} dropped by Jev` : ""}`,
            verdict.summary,
            ...judged.map((j) => `${j.finding.blocks ? "✗" : "·"} ${findingLine(j.finding)}\n  ${j.finding.failureScenario}\n  ${j.reason}`),
          ].join("\n"),
        )
        errors.delete(id)

        // The agent may have pushed again while the reviewer read the old head: that head gets its own review.
        if ((yield* github.prHead(prUrl)) !== head) {
          return yield* repo.log(id, "status", "The branch moved during the review; its result is dropped")
        }
        const critique: Critique = { reviewer: profile.vendor, sha: head, findings, response: null }
        const step = critiqueStep(session, blocking)
        switch (step._tag) {
          case "Ready":
            return yield* ready(session, critique)
          case "HandOff":
            return yield* handOff(id, critique, step, session)
          case "SendBack": {
            // Recorded before the turn: a message delivered into a running turn carries no patch.
            if ((yield* stillReviewing(id, (current) => ({ ...current, critique, critiqueRounds: step.round }), session)) === undefined) return
            return yield* deliverFindings(id, critique, step.round)
          }
        }
      })

    /** A round's blocking findings to the agent, as its next turn. */
    const deliverFindings = (id: string, critique: Critique, round: number) =>
      Effect.gen(function* () {
        const blocking = critique.findings.filter((f) => f.blocks)
        const delivery = yield* runner.continueWith(id, critiqueFailedPrompt(blocking, round, MAX_CRITIQUE_ROUNDS), { phase: "fix", activity: fixingActivity(round) })
        if (delivery === "refused") yield* handOff(id, critique, cannotResume("send it the review findings"))
      })

    const onError = (id: string, message: string, title = "Review could not run") =>
      Effect.gen(function* () {
        const count = (errors.get(id) ?? 0) + 1
        errors.set(id, count)
        yield* repo.log(id, "error", `${title}: ${message}`)
        const step = reviewErrorStep(count, message, title)
        if (step._tag === "Retry") return
        errors.delete(id)
        yield* handOff(id, null, step)
      })

    const guarded = (id: string) =>
      review(id).pipe(
        // GHE refusing this network is shown once in the status, not counted against each session's review.
        Effect.catchTag("GheBlocked", () => hub.patchStatus({ github: "blocked" })),
        Effect.catch((error) => onError(id, error.message)),
        Effect.catchDefect((defect) => onError(id, errorMessage(defect))),
        Effect.ignore,
      )

    return {
      tick: Effect.gen(function* () {
        const sessions = yield* store.activeSessions()
        const reviewing = new Set<string>()
        for (const session of sessions) if (session.status === "critiquing" && !(yield* runner.busy(session.id))) reviewing.add(session.id)
        // A session that left review (stopped, closed, your message) no longer needs its codex run.
        for (const [id] of Array.from(reviews)) if (!reviewing.has(id)) yield* FiberMap.remove(reviews, id)
        if ((yield* hub.status).github === "blocked") return
        const settings = yield* hub.settings
        for (const session of sessions) {
          if (!reviewing.has(session.id)) continue
          // Turned off in Settings: what is waiting for a review goes on to CI instead.
          if (!settings.adversarialReview) {
            yield* FiberMap.run(reviews, session.id, toCi(session, "Review is turned off; the PR is out of draft", false).pipe(Effect.ignore), { onlyIfMissing: true })
            continue
          }
          // Reviews are as heavy as agent turns: no more of them at once than agents.
          if (!(yield* FiberMap.has(reviews, session.id)) && (yield* FiberMap.size(reviews)) >= settings.maxConcurrent) break
          yield* FiberMap.run(reviews, session.id, guarded(session.id), { onlyIfMissing: true })
        }
      }),
    }
  }),
)
