import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { sdkOptions } from "../../src/agent/options.ts"
import { makeSession } from "../support/records.ts"
import { scratchDir } from "../support/tmp.ts"

describe("investigation configuration", () => {
  test("only the user's own settings load, so repo MCP and settings never add executable authority", () => {
    const dir = scratchDir("bt-mcp-")
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { grafana: { type: "http", url: "https://attacker.invalid" } } }))
    const options = sdkOptions({
      session: makeSession("running", { repoPath: dir, worktree: dir }), home: dir, daemonPort: 47621, resume: false,
      abort: new AbortController(), onRefused: () => {},
      tools: { report: async () => {}, ask: async () => undefined, slackContext: async () => "", memorySearch: async () => "", memoryRead: async () => "", memoryRemember: async () => false },
    })
    expect(options.settingSources).toEqual(["user"])
    expect(options.tools).toEqual(["ToolSearch", "WebSearch", "Skill"])
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["bridgetown"])
    // `dontAsk` would refuse the broker's own MCP tools before canUseTool runs.
    expect(options.permissionMode).toBe("default")
    expect(options.allowedTools).toBeUndefined()
    for (const name of ["Bash", "Read", "Edit", "Write", "Task", "Agent"]) expect(options.disallowedTools).toContain(name)
  })
})

test("the user's MCP tools run, while shell and files stay behind the broker", async () => {
  const home = scratchDir("bt-memory-sandbox-")
  const options = sdkOptions({
    home, session: makeSession("running"), abort: new AbortController(), resume: false, daemonPort: 9999,
    onRefused: () => {},
    tools: {
      memorySearch: async () => "", memoryRead: async () => "", memoryRemember: async () => true,
      report: async () => {}, ask: async () => undefined, slackContext: async () => "",
    },
  })
  for (const name of ["Bash", "Read", "Write", "Task", "mcp__bridgetown__unknown", "mcp__bridgetown__memory_read", "mcp__claude_ai_Notion__notion-fetch", "mcp__claude_ai_Notion__notion-update-page", "ToolSearch", "WebFetch"]) {
    const decision = ["Bash", "Read", "Write", "Task", "mcp__bridgetown__unknown", "mcp__claude_ai_Notion__notion-update-page", "WebFetch"].includes(name) ? "deny" : "allow"
    expect((await options.canUseTool?.(name, { path: "MEMORY.md" }, { signal: new AbortController().signal, toolUseID: "test", requestId: "test" }))?.behavior).toBe(decision)
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0]
    const reply = await hook?.({ hook_event_name: "PreToolUse", tool_name: name, tool_input: {}, tool_use_id: "test", session_id: "test", transcript_path: "", cwd: home }, "test", { signal: new AbortController().signal })
    expect(reply).toEqual(decision === "allow" ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.any(String) } })
  }
})
