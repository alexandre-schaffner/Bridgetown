import { describe, expect, test } from "bun:test"
import { callTool, CODEX_TOOLS, makeToolServer, TOOL_SERVER, type ToolCallbacks } from "../../src/agent/tools.ts"
import { connectTools } from "../support/sdk.ts"

const recordingTools = () => {
  const calls: Array<unknown> = []
  const callbacks: ToolCallbacks = {
    memorySearch: async (query) => { calls.push({ query }); return "Memory context" },
    memoryRead: async (path) => { calls.push({ path }); return "Memory topic" },
    memoryRemember: async (text) => { calls.push({ text }); return true },
    report: async (phase, note, prUrl) => { calls.push({ phase, note, prUrl }) },
    ask: async (question, options) => { calls.push({ question, options }); return "staging" },
    slackContext: async (minutes) => { calls.push({ minutes }); return "Slack context" },
  }
  return { calls, callbacks }
}

describe("shared investigation tools", () => {
  test("Claude and Codex apply the same normalization and defaults", async () => {
    for (const provider of ["claude", "codex"]) {
      const { calls, callbacks } = recordingTools()
      const invoke = provider === "claude"
        ? await connectTools({ mcpServers: { [TOOL_SERVER]: makeToolServer(callbacks) } }, `tools-${provider}`)
        : (name: string, args: Record<string, unknown>) => callTool(callbacks, name, args)
      expect(await invoke("report", { phase: "pr", note: "Opened a fix", prUrl: "https://example.com/pull/123" })).toBe("Reported.")
      expect(await invoke("slack_context", {})).toBe("Slack context")
      expect(await invoke("ask", { question: "Which environment?" })).toBe("The user answered: staging")
      expect(await invoke("memory_search", { query: "billing" })).toBe("Memory context")
      expect(await invoke("memory_read", { path: "billing.md" })).toBe("Memory topic")
      expect(await invoke("memory_remember", { text: "Billing is owned by platform" })).toBe("Finding queued for background learning.")
      expect(calls).toEqual([
        { phase: "pr", note: "Opened a fix", prUrl: null },
        { minutes: 20 },
        { question: "Which environment?", options: [] },
        { query: "billing" },
        { path: "billing.md" },
        { text: "Billing is owned by platform" },
      ])
    }
  })

  test("Codex rejects unsupported phases and oversized coordination arguments before callbacks", async () => {
    const { calls, callbacks } = recordingTools()
    for (const args of [{ phase: "done", note: "Finished" }, { phase: "fix", note: "x".repeat(201) }]) {
      await expect(callTool(callbacks, "report", args)).rejects.toThrow()
    }
    for (const args of [
      { question: "x".repeat(501) },
      { question: "Choose", options: ["a", "b", "c", "d", "e"] },
      { question: "Choose", options: ["x".repeat(81)] },
    ]) {
      await expect(callTool(callbacks, "ask", args)).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })

  test("Codex advertises the enforced argument limits", () => {
    expect(CODEX_TOOLS.find((tool) => tool.name === "report")?.inputSchema).toMatchObject({
      properties: { phase: { enum: ["diagnose", "fix", "pr", "ci"] }, note: { maxLength: 200 } },
    })
    expect(CODEX_TOOLS.find((tool) => tool.name === "ask")?.inputSchema).toMatchObject({
      properties: { question: { maxLength: 500 }, options: { maxItems: 4, items: { maxLength: 80 } } },
    })
  })
})
