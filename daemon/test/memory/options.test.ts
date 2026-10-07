import { expect, test } from "bun:test"
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { memoryOptions } from "../../src/memory/memory.ts"

test("memory jobs expose only source readers, enforce budgets and reject every other tool", async () => {
  const abort = new AbortController()
  const server = createSdkMcpServer({ name: "memory", version: "1", tools: [] })
  const options = memoryOptions(abort, "learn", "/memory", server)
  expect(options.tools).toEqual([])
  expect(options.settingSources).toEqual([])
  expect(options.strictMcpConfig).toBe(true)
  expect(options.persistSession).toBe(false)
  expect(options.maxBudgetUsd).toBe(0.5)
  expect(options.maxTurns).toBe(12)
  expect(memoryOptions(abort, "dream", "/memory", server).maxBudgetUsd).toBe(1)
  for (const name of ["Bash", "Write", "Read", "WebFetch", "Task", "Agent", "CronCreate", "mcp__grafana__query", "mcp__memory__write"]) {
    expect((await options.canUseTool?.(name, {}, { signal: abort.signal, toolUseID: "test", requestId: "test" }))?.behavior).toBe("deny")
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0]
    const reply = await hook?.({ hook_event_name: "PreToolUse", tool_name: name, tool_input: {}, tool_use_id: "test", session_id: "job", transcript_path: "", cwd: "/memory" }, "test", { signal: abort.signal })
    expect(reply).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
  }
  expect((await options.canUseTool?.("mcp__memory__read", { path: "MEMORY.md" }, { signal: abort.signal, toolUseID: "test", requestId: "test" }))?.behavior).toBe("allow")
})
