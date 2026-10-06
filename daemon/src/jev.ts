import { type EntryType, type Questions, TypeSafeClient } from "@typesafe-ai/sdk"
import { Context, Effect, Layer } from "effect"
import type { JevVerdict } from "./domain/alert.ts"
import type { FindingVerdict } from "./domain/critique.ts"
import { type AdapterError, attempt, MissingCredential } from "./domain/errors.ts"
import { type FindingJudgeInput, findingQuestions, findingState } from "./critique/judge.ts"
import { type LogPatternInput, type LogPatternVerdict, logPatternQuestions, logPatternState } from "./watch/judge.ts"
import { alertQuestions, alertState, type InboxJudgeInput, inboxQuestions, inboxState, type JudgeInput } from "./triage/judge.ts"

export interface JevShape {
  readonly judge: (input: JudgeInput) => Effect.Effect<JevVerdict, MissingCredential | AdapterError>
  readonly judgeInbox: (input: InboxJudgeInput) => Effect.Effect<JevVerdict, MissingCredential | AdapterError>
  /** Whether a reviewer finding is a real, blocking defect, not a nitpick or an argument already settled. */
  readonly judgeFinding: (input: FindingJudgeInput) => Effect.Effect<FindingVerdict, MissingCredential | AdapterError>
  /** One call for a batch of log patterns: whether each is a real problem, agent work, and hurting users. In input order. */
  readonly judgeLogPatterns: (patterns: ReadonlyArray<LogPatternInput>) => Effect.Effect<ReadonlyArray<LogPatternVerdict>, MissingCredential | AdapterError>
}

/** Jev, over TypeSafe's System One: each method asks one feature's questions (`judge.ts` beside it) and reads the answers as a verdict. */
export class Jev extends Context.Service<Jev, JevShape>()("Jev") {}

const noKey = new MissingCredential({ service: "jev", message: "no TypeSafe API key" })

export const makeJev = (apiKey: string | undefined, model: string): JevShape => {
  const client = apiKey === undefined || apiKey === "" ? undefined : new TypeSafeClient({
    apiKey,
    defaultModel: model,
    timeout: 15_000,
    retry: { maxRetries: 2 },
  })
  /** One System One call: the answers to `questions` about `state`, or `MissingCredential` without a key. */
  const ask = <const Q extends Questions>(state: EntryType, questions: Q) =>
    client === undefined
      ? Effect.fail(noKey)
      : attempt("jev", "systemOne", () => client.systemOne({ state, questions })).pipe(Effect.map((result) => result.answers))
  return {
    judge: Effect.fn("Jev.judge")(function* (input: JudgeInput) {
      const answers = yield* ask(alertState(input), alertQuestions())
      return {
        actionable: answers.actionable.noul,
        agentResolvable: answers.agent_resolvable.noul,
        humanOnIt: answers.human_on_it.noul,
        kind: answers.kind.choice,
        kindConfidence: answers.kind.confidence,
        depth: answers.depth.choice,
        urgency: answers.urgency.score,
      }
    }),
    judgeInbox: Effect.fn("Jev.judgeInbox")(function* (input: InboxJudgeInput) {
      const answers = yield* ask(inboxState(input), inboxQuestions())
      return {
        actionable: answers.needs_me.noul,
        agentResolvable: answers.delegable.noul,
        humanOnIt: answers.already_handled.noul,
        kind: answers.kind.choice,
        kindConfidence: answers.kind.confidence,
        depth: answers.depth.choice,
        urgency: answers.urgency.score,
      }
    }),
    judgeFinding: Effect.fn("Jev.judgeFinding")(function* (input: FindingJudgeInput) {
      const { first, later } = findingQuestions()
      const state = findingState(input)
      if (input.previousRound === null) {
        const answers = yield* ask(state, first)
        return { realDefect: answers.real_defect.noul, blocking: answers.blocking.noul, rebutted: null }
      }
      const answers = yield* ask(state, later)
      return { realDefect: answers.real_defect.noul, blocking: answers.blocking.noul, rebutted: answers.rebutted.noul }
    }),
    judgeLogPatterns: Effect.fn("Jev.judgeLogPatterns")(function* (patterns: ReadonlyArray<LogPatternInput>) {
      if (patterns.length === 0) return []
      const answers = yield* ask(logPatternState(patterns), logPatternQuestions(patterns.length))
      const yes = (key: string) => answers[key]?.noul ?? 0
      return patterns.map((_, i) => ({ problem: yes(`p${i}_problem`), agent: yes(`p${i}_agent`), users: yes(`p${i}_users`) }))
    }),
  }
}

export const JevLive = (apiKey: string | undefined, model: string) => Layer.succeed(Jev)(makeJev(apiKey, model))
