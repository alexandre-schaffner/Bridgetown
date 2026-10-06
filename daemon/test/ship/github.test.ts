import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Health } from "../../src/health.ts"
import { Hub } from "../../src/hub.ts"
import { ciState, type Reachability, refusedByAllowList } from "../../src/ship/github.ts"
import { fakeGitHub } from "../support/fakes.ts"
import { makeWorld } from "../support/world.ts"

describe("GHE allow list", () => {
  test("gh and git refusals from the IP allow list are recognised; other failures are not", () => {
    expect(refusedByAllowList("HTTP 403: Although you appear to have the correct authorization credentials, the `Merkl` organization has an IP allow list enabled")).toBe(true)
    expect(refusedByAllowList("fatal: unable to access 'https://nocturlab.ghe.com/…': The requested URL returned error: 403")).toBe(true)
    expect(refusedByAllowList("could not resolve host")).toBe(false)
  })
})

describe("GHE probe", () => {
  test("blocked and back: Status.github says it, and Status.error never repeats it", async () => {
    let reachable: Reachability = "blocked"
    const world = makeWorld({ github: fakeGitHub({ reachability: Effect.sync(() => reachable) }) })
    try {
      const probe = Effect.gen(function* () {
        yield* (yield* Health).probeGithub
        return yield* (yield* Hub).status
      })
      expect(await world.runPromise(probe)).toMatchObject({ github: "blocked", error: null })
      reachable = "ok"
      expect(await world.runPromise(probe)).toMatchObject({ github: "ok", error: null })
    } finally {
      await world.dispose()
    }
  })
})

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
