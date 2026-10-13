import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AdapterError, Conflict, GheBlocked } from "../../src/domain/errors.ts"
import { Health } from "../../src/health.ts"
import { Hub } from "../../src/hub.ts"
import { ciState, type Reachability, refusedByAllowList, transientGitHub } from "../../src/ship/github.ts"
import { fakeGitHub } from "../support/fakes.ts"
import { makeWorld } from "../support/world.ts"

describe("GHE allow list", () => {
  test("gh and git refusals from the IP allow list are recognised; other failures are not", () => {
    expect(refusedByAllowList("HTTP 403: Although you appear to have the correct authorization credentials, the `Merkl` organization has an IP allow list enabled")).toBe(true)
    expect(refusedByAllowList("fatal: unable to access 'https://nocturlab.ghe.com/…': The requested URL returned error: 403")).toBe(true)
    expect(refusedByAllowList("could not resolve host")).toBe(false)
  })
})

describe("transient GitHub failures", () => {
  const adapter = (message: string) => new AdapterError({ adapter: "subprocess", operation: "gh pr merge", message, cause: null })
  test("a busy GitHub, a dropped connection or a moved base branch is worth asking again", () => {
    for (const message of [
      "exited 1: GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)",
      "exited 1: HTTP 502: Bad Gateway (https://nocturlab.ghe.com/api/graphql)",
      "exited 1: GraphQL: Something went wrong while executing your query. (mergePullRequest)",
      "exited 1: Post \"https://nocturlab.ghe.com/api/graphql\": read tcp: connection reset by peer",
      "exited 1: net/http: TLS handshake timeout",
      "Timed out: command.",
    ]) expect(transientGitHub(adapter(message))).toBe(true)
  })
  test("a refusal is not", () => {
    expect(transientGitHub(adapter("exited 1: GraphQL: Pull request is not mergeable: the merge commit cannot be cleanly created (mergePullRequest)"))).toBe(false)
    expect(transientGitHub(adapter("exited 1: GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)"))).toBe(false)
    expect(transientGitHub(new GheBlocked({ operation: "gh pr merge", message: "HTTP 403: IP allow list" }))).toBe(false)
    expect(transientGitHub(new Conflict({ message: "The PR is no longer ready to merge. Refresh its checks and review." }))).toBe(false)
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
