import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { pinnedBunVersion, Worktrees, WorktreesLive } from "../src/sessions/worktree.ts"
import { commit, scratchRepo, sh } from "./fixtures/repo.ts"

const worktrees = <A, E>(f: (w: Worktrees["Service"]) => Effect.Effect<A, E>) => Effect.runPromise(Worktrees.use(f).pipe(Effect.provide(WorktreesLive)))

const FAILING = { name: "x", private: true, packageManager: "bun@0.0.1", dependencies: { "bridgetown-no-such-package-xyz": "9.9.9" } }

describe("worktree setup", () => {
  test("a failing install is a warning, not a failure, and an install cut short runs again", async () => {
    const repo = scratchRepo(FAILING)
    const worktree = await worktrees((w) => w.create(repo, "fix-bt-test"))
    expect(existsSync(join(worktree.path, "package.json"))).toBe(true)
    expect(worktree.warnings.some((w) => w.includes("bun install"))).toBe(true)
    expect(worktree.bunMismatch).toContain("pins bun 0.0.1")
    // What a killed install leaves: a node_modules without the marker of a finished one.
    mkdirSync(join(worktree.path, "node_modules", "half-written"), { recursive: true })
    const again = await worktrees((w) => w.create(repo, "fix-bt-test"))
    expect(again.path).toBe(worktree.path)
    expect(again.warnings.some((w) => w.includes("bun install"))).toBe(true)
  }, 60_000)

  test("a finished install is not run again", async () => {
    const repo = scratchRepo({ name: "x", private: true })
    const first = await worktrees((w) => w.create(repo, "fix-bt-done"))
    expect(first.warnings).toEqual([])
    // Would fail if it ran: the marker says it already succeeded.
    writeFileSync(join(first.path, "package.json"), JSON.stringify(FAILING))
    expect((await worktrees((w) => w.create(repo, "fix-bt-done"))).warnings).toEqual([])
  }, 60_000)

  test("a branch only origin still has is checked out from origin, not from main", async () => {
    const repo = scratchRepo()
    sh("git checkout -q -b fix-bt-pushed", repo)
    writeFileSync(join(repo, "fix.txt"), "the agent's fix")
    sh("git add fix.txt", repo)
    commit("the agent's fix", repo)
    const pushed = sh("git rev-parse HEAD", repo)
    sh("git push -q -u origin fix-bt-pushed && git checkout -q main && git branch -q -D fix-bt-pushed", repo)
    const worktree = await worktrees((w) => w.create(repo, "fix-bt-pushed"))
    expect(sh("git rev-parse HEAD", worktree.path)).toBe(pushed)
  }, 60_000)

  test("anything but a session branch is refused before a path is made from it", async () => {
    const repo = scratchRepo()
    for (const branch of ["", "main", "fix-bt-../../x", "feat-mine"]) {
      const created = await Effect.runPromise(Worktrees.use((w) => w.create(repo, branch)).pipe(Effect.provide(WorktreesLive), Effect.flip))
      expect(created.message).toContain("is not a session branch")
      const removed = await Effect.runPromise(Worktrees.use((w) => w.remove(repo, branch, { deleteBranch: true })).pipe(Effect.provide(WorktreesLive), Effect.flip))
      expect(removed.message).toContain("is not a session branch")
    }
    expect(existsSync(join(repo, ".shared", ".keep"))).toBe(true)
  })

  test("reads the pinned bun version", () => {
    expect(pinnedBunVersion(scratchRepo({ name: "x", packageManager: "bun@1.4.2" }))).toBe("1.4.2")
    expect(pinnedBunVersion(scratchRepo({ name: "x" }))).toBeUndefined()
  })
})

describe("worktree removal", () => {
  const branches = (repo: string) => sh("git for-each-ref '--format=%(refname:short)' refs/heads/", repo).split("\n").sort()

  test("the worktree goes; the branch and its follow-ups too unless kept", async () => {
    const repo = scratchRepo()
    const kept = await worktrees((w) => w.create(repo, "fix-bt-kept"))
    await worktrees((w) => w.remove(repo, "fix-bt-kept", { deleteBranch: false }))
    expect(existsSync(kept.path)).toBe(false)
    expect(branches(repo)).toEqual(["fix-bt-kept", "main"])

    const done = await worktrees((w) => w.create(repo, "fix-bt-done"))
    sh("git branch fix-bt-done-2 && git branch fix-bt-done-other", done.path)
    writeFileSync(join(done.path, "uncommitted.txt"), "work in progress")
    await worktrees((w) => w.remove(repo, "fix-bt-done", { deleteBranch: true }))
    expect(existsSync(done.path)).toBe(false)
    expect(branches(repo)).toEqual(["fix-bt-done-other", "fix-bt-kept", "main"])
    expect(sh("git worktree list --porcelain", repo).includes("fix-bt-done")).toBe(false)
  }, 60_000)

  test("a directory git no longer knows as a worktree is removed too, and removing twice is fine", async () => {
    const repo = scratchRepo()
    const worktree = await worktrees((w) => w.create(repo, "fix-bt-stray"))
    rmSync(join(worktree.path, ".git"))
    await worktrees((w) => w.remove(repo, "fix-bt-stray", { deleteBranch: true }))
    await worktrees((w) => w.remove(repo, "fix-bt-stray", { deleteBranch: true }))
    expect(existsSync(worktree.path)).toBe(false)
    expect(branches(repo)).toEqual(["main"])
  }, 60_000)
})
