import { describe, expect, test } from "bun:test"
import { critiqueStep, MAX_CRITIQUE_ROUNDS, MAX_REVIEW_ERRORS, reviewErrorStep } from "../../src/critique/transitions.ts"
import { makeFinding, makeSession } from "../support/records.ts"

describe("critique rounds", () => {
  const reviewing = (critiqueRounds: number) => makeSession("critiquing", { critiqueRounds })
  test("no blocking finding: on to CI", () => {
    expect(critiqueStep(reviewing(2), [])).toEqual({ _tag: "Ready" })
  })
  test("blocking findings send the agent back while rounds remain", () => {
    expect(critiqueStep(reviewing(0), [makeFinding()])).toEqual({ _tag: "SendBack", round: 1, phase: "fix", activity: `Fixing review findings (round 1 of ${MAX_CRITIQUE_ROUNDS})` })
    expect(critiqueStep(reviewing(MAX_CRITIQUE_ROUNDS - 1), [makeFinding()])).toMatchObject({ _tag: "SendBack", round: MAX_CRITIQUE_ROUNDS })
  })
  test("then the user decides, with what still blocks", () => {
    const step = critiqueStep(reviewing(MAX_CRITIQUE_ROUNDS), [makeFinding()])
    expect(step).toMatchObject({ _tag: "HandOff", title: "Review not passing" })
    expect(step._tag === "HandOff" && step.detail).toContain("reward.ts:88 — pending rewards still go through Number()")
  })
  test("a review that cannot run is retried, then handed off", () => {
    expect(reviewErrorStep(MAX_REVIEW_ERRORS - 1, "codex is not installed")).toEqual({ _tag: "Retry" })
    expect(reviewErrorStep(MAX_REVIEW_ERRORS, "codex is not installed")).toMatchObject({ _tag: "HandOff", detail: "The PR stays in draft. codex is not installed" })
  })
})
