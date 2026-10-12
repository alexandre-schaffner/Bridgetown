import { describe, expect, test } from "bun:test"
import { codexHookVerdict } from "../../src/guard/codex.ts"
import { claudeInvestigationToolRefusal, inheritedToolRefusal, investigationToolRefusal, reviewToolRefusal } from "../../src/security/capabilities.ts"

describe("broker-only Codex tools", () => {
  test("built-ins and arbitrary MCP operations cannot bypass broker authorization", () => {
    for (const name of ["Bash", "exec_command", "shell", "apply_patch", "view_image", "list_dir", "grep_files", "WebFetch", "read_file", "run", "spawn_agent", "mcp__grafana__grafana_api_request", "mcp__merkl__write", "mcp__bridgetown__unknown"]) {
      expect(investigationToolRefusal(name)).toBeDefined()
      expect(codexHookVerdict({ tool_name: name, tool_input: { command: "echo safe" }, cwd: "/w" }).hookSpecificOutput?.permissionDecision).toBe("deny")
    }
  })
  test("only explicitly brokered capabilities are permitted", () => {
    for (const name of ["bt_run", "bt_write_file", "bt_read_file", "bt_submit_fix", "bt_observe", "bt_github", "report", "ask", "slack_context", "memory_search", "memory_read", "memory_remember"]) {
      expect(investigationToolRefusal(name)).toBeUndefined()
      expect(investigationToolRefusal(`mcp__bridgetown__${name}`)).toBeUndefined()
    }
  })
  test("Claude sessions add the user's MCP servers and web reads, never built-in shell or files", () => {
    for (const name of ["mcp__claude_ai_Notion__notion-fetch", "mcp__grafana__query", "ToolSearch", "WebFetch", "WebSearch", "Skill", "mcp__bridgetown__bt_run"]) expect(claudeInvestigationToolRefusal(name)).toBeUndefined()
    for (const name of ["Bash", "Read", "Edit", "Write", "Task", "Agent", "mcp__bridgetown__unknown"]) expect(claudeInvestigationToolRefusal(name)).toBeDefined()
  })
  test("Codex investigations add the user's MCP tools, never built-in shell or files", () => {
    const verdict = (name: string) => codexHookVerdict({ tool_name: name, tool_input: {}, cwd: "/w" }, true).hookSpecificOutput?.permissionDecision
    // Codex refuses an explicit "allow"; no decision lets the call through.
    for (const name of ["mcp__notion__search", "mcp__codex_apps__gmail_search", "bt_run", "mcp__bridgetown__bt_run"]) expect(codexHookVerdict({ tool_name: name, tool_input: {}, cwd: "/w" }, true)).toEqual({})
    for (const name of ["Bash", "apply_patch", "exec_command", "WebFetch", "spawn_agent", "mcp__bridgetown__unknown"]) expect(verdict(name)).toBe("deny")
    expect(inheritedToolRefusal("ToolSearch")).toBeDefined()
  })
  test("reviewers cannot read or update persistent investigation memory", () => {
    for (const name of ["memory_search", "memory_read", "memory_remember"]) {
      expect(reviewToolRefusal(name)).toBeDefined()
      expect(reviewToolRefusal(`mcp__bridgetown__${name}`)).toBeDefined()
    }
  })
  test("malformed provider hooks fail closed", () => {
    for (const input of [null, {}, { tool_name: "run" }]) expect(codexHookVerdict(input).hookSpecificOutput?.permissionDecision).toBe("deny")
  })
})
