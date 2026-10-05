import { describe, expect, test } from "bun:test"
import { ciState } from "../src/ship/github.ts"
import { tagPrefix } from "../src/ship/transitions.ts"

const pr = (checks: ReadonlyArray<Record<string, string | null>>) => ({
  number: 1,
  title: "fix(app-admin): pin vite",
  state: "OPEN",
  mergedAt: null,
  headRefOid: "aaaa111",
  url: "https://nocturlab.ghe.com/Merkl/monorepo/pull/1",
  reviewDecision: null,
  latestReviews: [],
  statusCheckRollup: checks,
})

describe("ci state", () => {
  test("pending while any check runs", () => {
    expect(ciState(pr([{ name: "lint", status: "IN_PROGRESS", conclusion: null }]))._tag).toBe("Pending")
    expect(ciState(pr([]))._tag).toBe("Pending")
  })
  test("green when all completed successfully", () => {
    expect(ciState(pr([{ name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }, { context: "title", state: "SUCCESS" }]))._tag).toBe("Green")
  })
  test("red names failing checks", () => {
    const state = ciState(pr([
      { name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://x/runs/1" },
      { name: "type", status: "IN_PROGRESS", conclusion: null },
    ]))
    expect(state).toEqual({ _tag: "Red", failing: [{ name: "lint", url: "https://x/runs/1" }] })
  })
})

describe("release helpers", () => {
  test("tag prefix", () => {
    expect(tagPrefix("admin-v0.6.0")).toBe("admin")
    expect(tagPrefix("states-exporter-v0.1.0")).toBe("states-exporter")
    expect(tagPrefix("admin")).toBe("admin")
  })
})
