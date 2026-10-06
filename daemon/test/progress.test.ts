import { describe, expect, test } from "bun:test"
import { progressOf } from "../src/domain/progress.ts"
import { NO_MILESTONES, type Session } from "../src/domain/session.ts"
import { makeSession } from "./support/records.ts"

const session = (overrides: Partial<Session>): Session => makeSession(overrides.status ?? "running", { worktree: "/w", ...overrides })
const states = (s: Session) => progressOf(s).steps.map((step) => `${step.label}:${step.state}`)

describe("progress is evidence, not intent", () => {
  test("closed without a root cause shows nothing done", () => {
    const p = progressOf(session({ status: "closed", rootCauseFound: false, resolution: "root cause not found", phase: "done" }))
    expect(states(session({ status: "closed", rootCauseFound: false, phase: "done" }))).toEqual([
      "Root cause?:failed", "Fix:pending", "PR:pending", "Review:pending", "CI:pending", "Deploy:pending",
    ])
    expect(p).toMatchObject({ headline: "Closed · root cause not found", tone: "neutral" })
  })
  test("running: diagnosed, fixing", () => {
    expect(states(session({ milestones: { ...NO_MILESTONES, diagnosed: true } }))).toEqual([
      "Diagnose:done", "Fix:current", "PR:pending", "Review:pending", "CI:pending", "Deploy:pending",
    ])
  })
  test("pushed but no PR, then failed", () => {
    expect(states(session({ status: "failed", milestones: { ...NO_MILESTONES, diagnosed: true, fixed: true } }))).toEqual([
      "Diagnose:done", "Fix:done", "No PR:failed", "Review:pending", "CI:pending", "Deploy:pending",
    ])
  })
  test("deployed is all done", () => {
    const m = { diagnosed: true, fixed: true, prOpened: true, critiqued: true, ciGreen: true, merged: true, released: true, deployed: true }
    const p = progressOf(session({ status: "resolved", milestones: m, resolution: "deployed admin-v0.6.1" }))
    expect(p.steps.every((s) => s.state === "done")).toBe(true)
    expect(p).toMatchObject({ headline: "Resolved · deployed admin-v0.6.1", tone: "success" })
  })
  test("merged with nothing to ship skips deploy", () => {
    const m = { ...NO_MILESTONES, diagnosed: true, fixed: true, prOpened: true, critiqued: true, ciGreen: true, merged: true }
    expect(states(session({ status: "resolved", milestones: m }))).toEqual([
      "Diagnose:done", "Fix:done", "PR:done", "Review:done", "CI:done", "No deploy:skipped",
    ])
  })

  describe("the adversarial review", () => {
    const pushed = { ...NO_MILESTONES, diagnosed: true, fixed: true, prOpened: true }
    test("reviewing: the review step is where the session is", () => {
      const p = progressOf(session({ status: "critiquing", critiqueRounds: 1, milestones: pushed }))
      expect(states(session({ status: "critiquing", milestones: pushed }))).toEqual([
        "Diagnose:done", "Fix:done", "PR:done", "Review:current", "CI:pending", "Deploy:pending",
      ])
      expect(p).toMatchObject({ headline: "Codex reviewing · round 2", tone: "live" })
    })
    test("passed: done, and CI is next", () => {
      expect(states(session({ status: "ci", milestones: { ...pushed, critiqued: true } }))).toEqual([
        "Diagnose:done", "Fix:done", "PR:done", "Review:done", "CI:current", "Deploy:pending",
      ])
    })
    test("shipped without one (setting off, or before reviews existed): skipped, never done", () => {
      expect(states(session({ status: "ci", milestones: pushed }))).toEqual([
        "Diagnose:done", "Fix:done", "PR:done", "No review:skipped", "CI:current", "Deploy:pending",
      ])
    })
    test("re-reviewing new commits after CI went green shows the review as current again", () => {
      expect(states(session({ status: "critiquing", milestones: { ...pushed, ciGreen: true } }))[3]).toBe("Review:current")
    })
    test("the review row says where the review stands, from the step and the last review", () => {
      const finding = (blocks: boolean) => ({ file: "a.ts", line: 1, title: "t", failureScenario: "f", jev: null, blocks })
      const line = (overrides: Partial<Session>) => progressOf(session(overrides)).critiqueLine
      expect(line({ status: "critiquing", critiqueRounds: 1, milestones: pushed })).toBe("Reviewing · round 2")
      const passed = { reviewer: "codex" as const, sha: "abc", findings: [finding(false), finding(false)], response: null }
      expect(line({ status: "ci", critiqueRounds: 1, critique: passed, milestones: { ...pushed, critiqued: true } })).toBe("Passed · 1 round of fixes · 2 dropped by Jev")
      const failed = { ...passed, findings: [finding(true), finding(false)] }
      expect(line({ status: "running", critique: failed, milestones: pushed })).toBe("1 blocking finding · 1 dropped by Jev · agent fixing")
      expect(line({ status: "ci", milestones: pushed })).toBe("Not run")
      expect(progressOf(session({ status: "critiquing", milestones: pushed })).reviewerName).toBe("Codex")
      // Findings recorded, the agent's turn waiting for a slot: nobody is reviewing.
      const parked = progressOf(session({ status: "critiquing", critique: failed, milestones: pushed }))
      expect(parked).toMatchObject({ headline: "Review findings wait for a free agent slot", critiqueLine: "1 blocking finding · 1 dropped by Jev · waiting for an agent slot" })
    })
    test("the agent fixing a review's findings after CI went green: the review is still in progress, not skipped", () => {
      const critique = { reviewer: "codex" as const, sha: "abc", findings: [], response: null }
      expect(states(session({ status: "running", critique, milestones: { ...pushed, ciGreen: true } }))[3]).toBe("Review:current")
    })
  })
})
