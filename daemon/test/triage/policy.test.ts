import { describe, expect, test } from "bun:test"
import type { FindingVerdict } from "../../src/domain/critique.ts"
import { DEFAULT_SETTINGS } from "../../src/domain/settings.ts"
import { decide, decideAnomaly, decideFinding, decideInbox } from "../../src/triage/policy.ts"
import { verdict } from "../support/fakes.ts"

const t = DEFAULT_SETTINGS.thresholds

describe("policy", () => {
  test("auto when confident and unclaimed", () => {
    expect(decide(verdict({}), t).decision).toBe("auto")
  })
  test("claimed alerts downgrade to suggest", () => {
    expect(decide(verdict({ humanOnIt: 0.7 }), t).decision).toBe("suggest")
  })
  test("borderline is suggest", () => {
    expect(decide(verdict({ actionable: 0.6, agentResolvable: 0.5 }), t).decision).toBe("suggest")
  })
  test("ignore informational and human-only", () => {
    expect(decide(verdict({ actionable: 0.1 }), t).decision).toBe("ignore")
    expect(decide(verdict({ agentResolvable: 0.1 }), t).decision).toBe("ignore")
  })
  test("an anomaly is investigated unless Jev sees nothing in it, then suggested", () => {
    expect(decideAnomaly(verdict({}), t).decision).toBe("auto")
    expect(decideAnomaly(verdict({ actionable: 0.6, agentResolvable: 0.5 }), t).decision).toBe("auto")
    expect(decideAnomaly(verdict({ humanOnIt: 0.7 }), t).decision).toBe("auto")
    expect(decideAnomaly(verdict({ actionable: 0.1 }), t)).toMatchObject({ decision: "suggest", reason: expect.stringContaining("Jev doubts it") })
  })
})

describe("inbox policy", () => {
  test("delegate, suggest, escalate, ignore", () => {
    expect(decideInbox(verdict({}), t).decision).toBe("auto")
    expect(decideInbox(verdict({ agentResolvable: 0.55 }), t).decision).toBe("suggest")
    expect(decideInbox(verdict({ agentResolvable: 0.1, kind: "decision_or_approval" }), t).decision).toBe("escalate")
    expect(decideInbox(verdict({ kind: "pr_review" }), t).decision).toBe("escalate")
    expect(decideInbox(verdict({ actionable: 0.1 }), t).decision).toBe("ignore")
    expect(decideInbox(verdict({ humanOnIt: 0.9 }), t).decision).toBe("ignore")
  })
})

describe("Jev drops the nitpicks", () => {
  const jev = (overrides: Partial<FindingVerdict> = {}): FindingVerdict => ({ realDefect: 0.9, blocking: 0.85, rebutted: null, ...overrides })
  const rows: ReadonlyArray<readonly [string, FindingVerdict, boolean]> = [
    ["a real, blocking defect", jev(), true],
    ["a nitpick", jev({ realDefect: 0.1, blocking: 0.05 }), false],
    ["real but safe to ship", jev({ blocking: 0.3 }), false],
    ["answered by the agent's reply", jev({ rebutted: 0.8 }), false],
    ["a reply that does not answer it", jev({ rebutted: 0.2 }), true],
    ["at the thresholds", jev({ realDefect: t.findingReal, blocking: t.findingBlocking, rebutted: t.findingRebutted - 0.01 }), true],
    ["just under the real-defect threshold", jev({ realDefect: t.findingReal - 0.01 }), false],
    ["rebutted exactly at the threshold", jev({ rebutted: t.findingRebutted }), false],
  ]
  for (const [label, verdict, blocks] of rows) {
    test(label, () => expect(decideFinding(verdict, t).blocks).toBe(blocks))
  }
  test("the reason carries the numbers", () => {
    expect(decideFinding(jev({ realDefect: 0.12, blocking: 0.05 }), t).reason).toBe("Not a real defect (real 12% · blocking 5%)")
    expect(decideFinding(jev({ rebutted: 0.8 }), t).reason).toBe("Answered by the agent (real 90% · blocking 85% · rebutted 80%)")
  })
})
