import { describe, expect, test } from "bun:test"
import { findingState } from "../../src/critique/judge.ts"

describe("Jev's view of a finding", () => {
  const input = {
    change: { title: "merkl-api · 502s", diagnosis: "overflow" },
    finding: { file: "a.ts", line: 3, title: "x", failureScenario: "y" },
    diff: "+".repeat(10_000),
    previousRound: null,
  }
  test("long diffs are cut, and the first round has no previous round", () => {
    const state = findingState(input)
    expect(state.diff.length).toBeLessThan(6_100)
    expect(state.diff.endsWith("… (diff cut)")).toBe(true)
    expect("previousRound" in state).toBe(false)
  })
  test("later rounds include the agent's reply", () => {
    const state = findingState({ ...input, previousRound: { findings: [input.finding], reply: "fixed" } })
    expect(state).toMatchObject({ previousRound: { reply: "fixed", findings: [input.finding] } })
  })
})
