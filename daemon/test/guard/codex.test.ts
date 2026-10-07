import { describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codexHookVerdict, codexToolRefusal } from "../../src/guard/codex.ts"
import { readScript } from "../../src/guard/bash.ts"
import type { ToolGuard } from "../../src/guard/hook.ts"
import { scratchDir } from "../support/tmp.ts"

const worktree = scratchDir("bt-codex-guard-")
const guard: ToolGuard = { worktree, cwd: worktree, branch: "fix-bt-s", daemonPort: 47621, readFile: () => undefined }
describe("Codex tool guards", () => {
  test("commands use the existing production, branch and daemon policies", () => {
    for (const command of ["kubectl delete pod p", "git push origin main", "gh pr merge 1", "curl http://127.0.0.1:47621/state"]) {
      expect(codexToolRefusal(guard, "Bash", { command })).toBeDefined()
    }
    expect(codexToolRefusal(guard, "Bash", { command: "git status" })).toBeUndefined()
    expect(codexToolRefusal(guard, "Bash", { command: "git push origin fix-bt-s" })).toBeUndefined()
  })
  test("patches check additions, deletions and move destinations, including symlinks", () => {
    symlinkSync(tmpdir(), join(worktree, "outside"))
    for (const path of ["../escape", "/tmp/escape", "outside/escape"]) {
      expect(codexToolRefusal(guard, "apply_patch", { command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` })).toBeDefined()
      expect(codexToolRefusal(guard, "apply_patch", { command: `*** Begin Patch\n*** Update File: ok.ts\n*** Move to: ${path}\n@@\n-x\n+y\n*** End Patch` })).toBeDefined()
    }
    expect(codexToolRefusal(guard, "apply_patch", { command: "*** Begin Patch\n*** Add File: ok.ts\n+x\n*** End Patch" })).toBeUndefined()
  })
  test("malformed hooks, unknown tools and subagents fail closed", () => {
    for (const name of ["spawn_agent", "Agent", "remote_execute", "request_permissions"]) expect(codexToolRefusal(guard, name, {})).toBeDefined()
    expect(codexHookVerdict(null, guard).hookSpecificOutput.permissionDecision).toBe("deny")
    expect(codexHookVerdict({ tool_name: "apply_patch", tool_input: {}, cwd: worktree }, guard).hookSpecificOutput.permissionDecision).toBe("deny")
  })
  test("shell execution uses the checked directory even when Codex hides a different tool workdir", () => {
    const root = scratchDir("bt-codex-cwd's-")
    const nested = join(root, "nested")
    mkdirSync(nested)
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo checked-root" } }))
    writeFileSync(join(nested, "package.json"), JSON.stringify({ scripts: { test: "/opt/homebrew/bin/kubectl delete pod p" } }))
    const context = { ...guard, worktree: root, cwd: root, readFile: readScript }
    const output = codexHookVerdict({ tool_name: "Bash", tool_input: { command: "bun run test" }, cwd: root }, context).hookSpecificOutput
    expect(output.permissionDecision).toBe("allow")
    const command = output.updatedInput?.command
    if (command === undefined) throw new Error("The command was not confined to the checked directory")
    const child = Bun.spawnSync(["/bin/sh", "-c", command], { cwd: nested })
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString().trim()).toBe("checked-root")
    expect(codexToolRefusal(context, "Bash", { command: "cd nested && bun run test" })).toBeDefined()
  })
  test("a missing checked directory exits before any shell branch can run", () => {
    const output = codexHookVerdict({ tool_name: "Bash", tool_input: { command: "printf unsafe || printf unsafe; printf unsafe" }, cwd: join(worktree, "missing") }, guard).hookSpecificOutput
    const command = output.updatedInput?.command
    if (command === undefined) throw new Error("The command was not confined to the checked directory")
    const child = Bun.spawnSync(["/bin/sh", "-c", command], { cwd: worktree })
    expect(child.exitCode).not.toBe(0)
    expect(child.stdout.toString()).toBe("")
  })
})
