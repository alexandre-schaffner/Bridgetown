import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Health } from "../src/health.ts"
import { Hub } from "../src/hub.ts"
import { type GitHubShape, refusedByAllowList, type Reachability } from "../src/ship/github.ts"
import { makeWorld } from "./fixtures/world.ts"

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
    const github: GitHubShape = {
      viewPr: () => Effect.die("unused"), mergePr: () => Effect.die("unused"), rerunFailedJobs: () => Effect.die("unused"),
      nextPatchTag: () => Effect.die("unused"), tagExists: () => Effect.die("unused"), createRelease: () => Effect.die("unused"),
      branchHead: () => Effect.succeed(null), prHead: () => Effect.die("unused"), markReady: () => Effect.die("unused"), reachability: Effect.sync(() => reachable),
    }
    const world = makeWorld({ github })
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
