import { describe, expect, test } from "bun:test"
import { NO_MILESTONES, type Session } from "../src/domain/model.ts"
import { progressOf } from "../src/domain/progress.ts"
import { makeSession } from "./fixtures/records.ts"

const session = (overrides: Partial<Session>): Session => makeSession(overrides.status ?? "running", { worktree: "/w", ...overrides })
const states = (s: Session) => progressOf(s).steps.map((step) => `${step.label}:${step.state}`)

describe("progress is evidence, not intent", () => {
  test("closed without a root cause shows nothing done", () => {
    const p = progressOf(session({ status: "closed", rootCauseFound: false, resolution: "root cause not found", phase: "done" }))
    expect(states(session({ status: "closed", rootCauseFound: false, phase: "done" }))).toEqual([
      "Root cause?:failed", "Fix:pending", "PR:pending", "CI:pending", "Deploy:pending",
    ])
    expect(p).toMatchObject({ headline: "Closed · root cause not found", tone: "neutral" })
  })
  test("running: diagnosed, fixing", () => {
    expect(states(session({ milestones: { ...NO_MILESTONES, diagnosed: true } }))).toEqual([
      "Diagnose:done", "Fix:current", "PR:pending", "CI:pending", "Deploy:pending",
    ])
  })
  test("pushed but no PR, then failed", () => {
    expect(states(session({ status: "failed", milestones: { ...NO_MILESTONES, diagnosed: true, fixed: true } }))).toEqual([
      "Diagnose:done", "Fix:done", "No PR:failed", "CI:pending", "Deploy:pending",
    ])
  })
  test("deployed is all done", () => {
    const m = { diagnosed: true, fixed: true, prOpened: true, ciGreen: true, merged: true, released: true, deployed: true }
    const p = progressOf(session({ status: "resolved", milestones: m, resolution: "deployed admin-v0.6.1" }))
    expect(p.steps.every((s) => s.state === "done")).toBe(true)
    expect(p).toMatchObject({ headline: "Resolved · deployed admin-v0.6.1", tone: "success" })
  })
  test("merged with nothing to ship skips deploy", () => {
    const m = { ...NO_MILESTONES, diagnosed: true, fixed: true, prOpened: true, ciGreen: true, merged: true }
    expect(states(session({ status: "resolved", milestones: m }))).toEqual([
      "Diagnose:done", "Fix:done", "PR:done", "CI:done", "No deploy:skipped",
    ])
  })
})
