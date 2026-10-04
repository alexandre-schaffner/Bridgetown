import { describe, expect, test } from "bun:test"
import { isMcpProblem, mcpProblem } from "../src/sessions/sdk-events.ts"

describe("MCP problems shown in the menu bar", () => {
  test("a login problem says where the login works", () => {
    expect(mcpProblem("merkl", "needs-auth")).toBe("merkl MCP · sessions: needs a login. Run `claude mcp login merkl` in the monorepo.")
  })

  test("grafana is started, not logged into", () => {
    expect(mcpProblem("grafana", "failed")).toContain("`bun grafana:mcp`")
  })

  test("other states name themselves", () => {
    expect(mcpProblem("merkl", "failed")).toBe("merkl MCP · sessions: failed. Check `claude mcp get merkl` in the monorepo.")
  })

  test("only our own MCP problems are cleared when servers come back", () => {
    expect(isMcpProblem(mcpProblem("merkl", "needs-auth"))).toBe(true)
    expect(isMcpProblem("Slack is failing")).toBe(false)
    expect(isMcpProblem(null)).toBe(false)
  })
})
