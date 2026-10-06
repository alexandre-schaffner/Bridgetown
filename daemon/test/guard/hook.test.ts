import { describe, expect, test } from "bun:test"
import { readScript } from "../../src/guard/bash.ts"
import { type ToolGuard, toolRefusal } from "../../src/guard/hook.ts"

const guard: ToolGuard = { branch: "fix-bt-foo-abcd", cwd: "/w", daemonPort: 47621, readFile: readScript, worktree: "/w" }

describe("the one tool gate", () => {
  test("any tool that runs a command goes through the shell policy, Bash or not", () => {
    expect(toolRefusal(guard, "Bash", { command: "gh pr merge 1" })).toBeDefined()
    expect(toolRefusal(guard, "Bash", { command: "bun test" })).toBeUndefined()
    // The CLI ships tools (Monitor) whose input is also `{ command }`; the preset would offer them unguarded.
    expect(toolRefusal(guard, "Monitor", { command: "gh run watch 1", description: "x", timeout_ms: 1000, persistent: false })).toBeDefined()
    expect(toolRefusal(guard, "Monitor", { command: "gh pr merge 1 --squash", description: "x", timeout_ms: 1000, persistent: false })).toBeDefined()
  })

  test("WebFetch's URL goes through the same host rules as a network command", () => {
    expect(toolRefusal(guard, "WebFetch", { url: "https://api.internal.merkl.xyz/v4/foo", prompt: "x" })).toBeDefined()
    expect(toolRefusal(guard, "WebFetch", { url: "https://hooks.slack.com/services/x", prompt: "x" })).toBeDefined()
    expect(toolRefusal(guard, "WebFetch", { url: "http://127.0.0.1:47621/state", prompt: "x" })).toBeDefined()
    expect(toolRefusal(guard, "WebFetch", { url: "https://api.merkl.xyz/v4/health", prompt: "x" })).toBeUndefined()
  })

  test("write tools are confined to the worktree", () => {
    expect(toolRefusal(guard, "Edit", { file_path: "~/.zshrc" })).toBeDefined()
    expect(toolRefusal(guard, "Write", { file_path: "/w/src/a.ts" })).toBeUndefined()
  })

  test("read tools and other tools are not blocked", () => {
    expect(toolRefusal(guard, "Read", { file_path: "/etc/hosts" })).toBeUndefined()
    expect(toolRefusal(guard, "Grep", { pattern: "foo" })).toBeUndefined()
    expect(toolRefusal(guard, "WebSearch", { query: "x" })).toBeUndefined()
  })

  test("it fails closed: a gate that throws refuses the call", () => {
    const broken: ToolGuard = {
      ...guard,
      readFile: () => {
        throw new Error("boom")
      },
    }
    // `source x` reaches readFile, which throws; the call must be refused, not allowed.
    expect(toolRefusal(broken, "Bash", { command: "source /w/x.sh" })).toBeDefined()
  })
})
