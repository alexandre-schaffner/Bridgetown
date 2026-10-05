import { describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { writeRefusal } from "../src/sessions/confine.ts"
import { scratchDir } from "./fixtures/tmp.ts"

const root = scratchDir("bt-confine-")
const worktree = join(root, "wt")
const outside = join(root, "elsewhere")
mkdirSync(join(worktree, "src"), { recursive: true })
mkdirSync(outside)
symlinkSync(outside, join(worktree, "escape"))

describe("file writes stay in the worktree", () => {
  test("inside, existing or new, absolute or relative", () => {
    expect(writeRefusal("Edit", { file_path: join(worktree, "src", "a.ts") }, worktree)).toBeUndefined()
    expect(writeRefusal("Write", { file_path: join(worktree, "new", "deep", "b.ts") }, worktree)).toBeUndefined()
    expect(writeRefusal("Write", { file_path: "src/c.ts" }, worktree)).toBeUndefined()
    expect(writeRefusal("NotebookEdit", { notebook_path: join(worktree, "n.ipynb") }, worktree)).toBeUndefined()
  })
  test("outside the worktree", () => {
    expect(writeRefusal("Write", { file_path: join(outside, "x") }, worktree)).toBeDefined()
    expect(writeRefusal("Edit", { file_path: "/Users/x/.zshrc" }, worktree)).toBeDefined()
    expect(writeRefusal("MultiEdit", { file_path: `${worktree}-sibling/a.ts` }, worktree)).toBeDefined()
  })
  test("`..` is refused even when it would land inside", () => {
    expect(writeRefusal("Edit", { file_path: `${worktree}/src/../a.ts` }, worktree)).toBeDefined()
    expect(writeRefusal("Write", { file_path: "../elsewhere/x" }, worktree)).toBeDefined()
  })
  test("a symlink out of the worktree is followed", () => {
    expect(writeRefusal("Write", { file_path: join(worktree, "escape", "x") }, worktree)).toBeDefined()
    expect(writeRefusal("Write", { file_path: join(worktree, "escape", "new", "x") }, worktree)).toBeDefined()
  })
  test("no worktree yet, or no path, is refused; reads and other tools are not checked", () => {
    expect(writeRefusal("Write", { file_path: join(worktree, "a") }, null)).toBeDefined()
    expect(writeRefusal("Write", {}, worktree)).toBeDefined()
    expect(writeRefusal("Read", { file_path: "/etc/hosts" }, worktree)).toBeUndefined()
    expect(writeRefusal("Bash", { command: "ls" }, worktree)).toBeUndefined()
  })
})
