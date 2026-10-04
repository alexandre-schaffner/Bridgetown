import type { Finding, Session } from "../domain/model.ts"
import { type Escalation, sendBackOrHandOff } from "../ship/transitions.ts"

/** Times the review may send the agent back on one PR before the user decides. */
export const MAX_CRITIQUE_ROUNDS = 4
/** Reviews in a row that could not run (codex missing, timed out, unreadable verdict) before the user is told. */
export const MAX_REVIEW_ERRORS = 3

export type CritiqueStep = { readonly _tag: "Ready" } | Escalation

export const findingLine = (f: Finding): string => `${f.file}${f.line === null ? "" : `:${f.line}`} — ${f.title}`

/** A review's blocking findings decide: on to CI, another round for the agent, or the user once the rounds are spent. */
export const critiqueStep = (session: Session, blocking: ReadonlyArray<Finding>): CritiqueStep =>
  blocking.length === 0
    ? { _tag: "Ready" }
    : sendBackOrHandOff(
        session.critiqueRounds,
        {
          phase: "fix",
          working: (round) => `Fixing review findings (round ${round} of ${MAX_CRITIQUE_ROUNDS})`,
          exhausted: {
            activity: `Review still failing after ${MAX_CRITIQUE_ROUNDS} rounds`,
            title: "Review not passing",
            detail: `The PR stays in draft. Still blocking:\n${blocking.map((f) => `· ${findingLine(f)}`).join("\n")}`,
          },
        },
        MAX_CRITIQUE_ROUNDS,
      )

/** After a review that could not run: try again on the next pass, or tell the user once it keeps failing. */
export const reviewErrorStep = (
  errors: number,
  message: string,
  title = "Review could not run",
): { readonly _tag: "Retry" } | Extract<CritiqueStep, { readonly _tag: "HandOff" }> =>
  errors < MAX_REVIEW_ERRORS ? { _tag: "Retry" } : { _tag: "HandOff", activity: title, title, detail: `The PR stays in draft. ${message}` }
