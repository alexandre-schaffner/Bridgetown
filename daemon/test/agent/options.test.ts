import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { sdkOptions } from "../../src/agent/options.ts"
import { makeSession } from "../support/records.ts"
import { scratchDir } from "../support/tmp.ts"

describe("investigation configuration", () => {
  test("repo MCP and inherited settings never add executable authority", () => {
    const dir = scratchDir("bt-mcp-")
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { grafana: { type: "http", url: "https://attacker.invalid" } } }))
    const options = sdkOptions({
      session: makeSession("running", { repoPath: dir, worktree: dir }), home: dir, daemonPort: 47621, resume: false,
      abort: new AbortController(), onRefused: () => {},
      tools: { report: async () => {}, ask: async () => undefined, slackContext: async () => "", memorySearch: async () => "", memoryRead: async () => "", memoryRemember: async () => false },
    })
    expect(options.settingSources).toEqual([])
    expect(options.tools).toEqual([])
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["bridgetown"])
    expect(options.permissionMode).toBe("dontAsk")
    expect(options.disallowedTools).toContain("WebFetch")
    expect(options.disallowedTools).toContain("Bash")
  })
})

test("memory access remains brokered and built-in tools cannot bypass it", async () => {
  const home = scratchDir("bt-memory-sandbox-")
  const options = sdkOptions({
    home, session: makeSession("running"), abort: new AbortController(), resume: false, daemonPort: 9999,
    onRefused: () => {},
    tools: {
      memorySearch: async () => "", memoryRead: async () => "", memoryRemember: async () => true,
      report: async () => {}, ask: async () => undefined, slackContext: async () => "",
    },
  })
  for (const name of ["Bash", "Read", "Write", "mcp__foreign__memory_read", "mcp__bridgetown__memory_read"]) {
    const decision = name === "mcp__bridgetown__memory_read" ? "allow" : "deny"
    expect((await options.canUseTool?.(name, { path: "MEMORY.md" }, { signal: new AbortController().signal, toolUseID: "test", requestId: "test" }))?.behavior).toBe(decision)
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0]
    const reply = await hook?.({ hook_event_name: "PreToolUse", tool_name: name, tool_input: {}, tool_use_id: "test", session_id: "test", transcript_path: "", cwd: home }, "test", { signal: new AbortController().signal })
    expect(reply).toEqual(decision === "allow" ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.any(String) } })
  }
})
