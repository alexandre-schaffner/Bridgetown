import { describe, expect, test } from "bun:test"
import type { Stage } from "../src/domain/alert.ts"
import { type ReleaseState, releaseHeadline, releaseState, sameReleaseState } from "../src/domain/release.ts"

const stage = (name: string, status: Stage["status"], detail = ""): Stage => ({ name, status, detail })

describe("releaseState", () => {
  const rows: ReadonlyArray<readonly [string, ReadonlyArray<Stage>, ReleaseState["_tag"], string]> = [
    ["no stages yet", [], "Starting", "Starting"],
    ["build failed", [stage("Approval", "success"), stage("Build", "failure", "1 attempt failed")], "Failed", "Build failed"],
    ["approval rejected", [stage("Approval", "failure")], "Failed", "Approval rejected"],
    ["a later stage failed", [stage("Build", "success"), stage("Production › ETL", "failure")], "Failed", "Production › ETL deploy failed"],
    ["waiting for approval", [stage("Build", "success"), stage("Approval", "pending")], "AwaitingApproval", "Waiting for approval"],
    ["rolling", [stage("Build", "success"), stage("Front Staging", "in_progress")], "InProgress", "Front Staging in progress"],
    ["deployed", [stage("Build", "success"), stage("Production", "success")], "Deployed", "Deployed"],
  ]
  for (const [label, stages, tag, headline] of rows) {
    test(label, () => {
      const state = releaseState(stages)
      expect(state._tag).toBe(tag)
      expect(releaseHeadline(state)).toBe(headline)
    })
  }
  test("a failure outranks a pending approval", () => {
    expect(releaseState([stage("Approval", "pending"), stage("Build", "failure")])._tag).toBe("Failed")
  })
})

describe("sameReleaseState", () => {
  test("same stage, different attempt count: not a change", () => {
    expect(sameReleaseState({ _tag: "Failed", stage: "Build", detail: "1 attempt failed" }, { _tag: "Failed", stage: "Build", detail: "2 attempts failed" })).toBe(true)
  })
  test("a different stage or state is a change; nothing recorded is a change", () => {
    expect(sameReleaseState({ _tag: "Failed", stage: "Build", detail: "" }, { _tag: "Failed", stage: "ETL", detail: "" })).toBe(false)
    expect(sameReleaseState({ _tag: "InProgress", stage: "Build" }, { _tag: "InProgress", stage: "ETL" })).toBe(false)
    expect(sameReleaseState({ _tag: "AwaitingApproval" }, { _tag: "Deployed" })).toBe(false)
    expect(sameReleaseState(null, { _tag: "Starting" })).toBe(false)
  })
})
