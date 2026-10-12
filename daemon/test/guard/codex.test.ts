import { describe, expect, test } from "bun:test"
import { codexHookVerdict } from "../../src/guard/codex.ts"
import { BROKER_PREFIX, claudeInvestigationToolRefusal, inheritedToolRefusal, investigationToolRefusal, reviewToolRefusal, TOOL_SERVER } from "../../src/security/capabilities.ts"

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
  test("Claude sessions add the user's MCP reads and web search, never built-in shell, files or WebFetch", () => {
    for (const name of ["mcp__claude_ai_Notion__notion-fetch", "ToolSearch", "WebSearch", "Skill", "mcp__bridgetown__bt_run"]) expect(claudeInvestigationToolRefusal(name)).toBeUndefined()
    for (const name of ["Bash", "Read", "Edit", "Write", "Task", "Agent", "WebFetch", "mcp__bridgetown__unknown"]) expect(claudeInvestigationToolRefusal(name)).toBeDefined()
  })
  test("inherited MCP tools only read", () => {
    const reads = ["mcp__claude_ai_Notion__notion-search", "mcp__claude_ai_Notion__notion-get-comments", "mcp__claude_ai_Notion__notion-query-data-sources", "mcp__claude_ai_Postman__getCollection", "mcp__claude_ai_Postman__searchPostmanElements", "mcp__linear__list_issues", "mcp__codex_apps__gmail_search"]
    const writes = [
      "mcp__claude_ai_Notion__notion-update-page", "mcp__claude_ai_Notion__notion-create-comment", "mcp__claude_ai_Notion__notion-send-message-to-session", "mcp__claude_ai_Notion__notion-spawn-session",
      "mcp__claude_ai_Notion__notion-get-file-download-urls", "mcp__claude_ai_Postman__createCollection", "mcp__claude_ai_Postman__putEnvironment", "mcp__claude_ai_Claude_Docs__batch", "mcp__codex_apps__gmail_send_email",
      // No verb that says it reads: refused rather than guessed.
      "mcp__claude_ai_Notion__notion-check-mcp-next-steps", "mcp__local__frobnicate",
    ]
    for (const name of reads) expect(inheritedToolRefusal(name)).toBeUndefined()
    for (const name of writes) expect(inheritedToolRefusal(name)).toContain("may only read")
  })
  test("the user's own copies of brokered servers cannot skip the broker's limits", () => {
    for (const name of ["mcp__grafana__query_prometheus", "mcp__grafana__list_dashboards", "mcp__github__get_file_contents", "mcp__claude_ai_Merkl__get_campaign", "mcp__claude_ai_Slack__slack_read_channel", "mcp__codex_apps__github_search"]) {
      expect(inheritedToolRefusal(name)).toContain("broker tools read")
    }
  })
  test("the broker's own server never counts as the user's", () => {
    expect(inheritedToolRefusal(`${BROKER_PREFIX}search_anything`)).toBeDefined()
    expect(inheritedToolRefusal(`mcp__${TOOL_SERVER}x__search`)).toBeUndefined()
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
