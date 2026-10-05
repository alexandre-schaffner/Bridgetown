import { describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { createWorktree, pinnedBunVersion } from "../src/sessions/worktree.ts"
import { scratchDir } from "./fixtures/tmp.ts"

const scratchRepo = (manifest: object): string => {
  const root = scratchDir("bt-wt-")
  const repo = join(root, "repo")
  mkdirSync(join(repo, ".shared"), { recursive: true })
  writeFileSync(join(repo, "package.json"), JSON.stringify(manifest))
  writeFileSync(join(repo, ".shared", ".keep"), "")
  const sh = (cmd: string, cwd = repo) => execSync(cmd, { cwd, stdio: "pipe" })
  sh("git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm init")
  sh(`git init -q --bare ${join(root, "origin.git")}`, root)
  sh(`git remote add origin ${join(root, "origin.git")} && git push -q origin main`)
  return repo
}

describe("worktree setup", () => {
  test("a failing install is a warning, not a failure", async () => {
    const repo = scratchRepo({ name: "x", private: true, packageManager: "bun@0.0.1", dependencies: { "bridgetown-no-such-package-xyz": "9.9.9" } })
    const worktree = await Effect.runPromise(createWorktree(repo, "fix-bt-test"))
    expect(existsSync(join(worktree.path, "package.json"))).toBe(true)
    expect(worktree.warnings.some((w) => w.includes("bun install"))).toBe(true)
    expect(worktree.warnings.some((w) => w.includes("pins bun 0.0.1"))).toBe(true)
    const again = await Effect.runPromise(createWorktree(repo, "fix-bt-test"))
    expect(again.path).toBe(worktree.path)
  }, 60_000)

  test("reads the pinned bun version", () => {
    expect(pinnedBunVersion(scratchRepo({ name: "x", packageManager: "bun@1.4.2" }))).toBe("1.4.2")
    expect(pinnedBunVersion(scratchRepo({ name: "x" }))).toBeUndefined()
  })
})
