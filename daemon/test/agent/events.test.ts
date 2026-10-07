import { describe, expect, test } from "bun:test"
import { impliedPhase, mcpProblem } from "../../src/agent/events.ts"

describe("implied phase", () => {
  test("edits mean fixing, gh pr create means pr", () => {
    expect(impliedPhase("Edit", { file_path: "x" })).toBe("fix")
    expect(impliedPhase("Bash", { command: "GH_HOST=x gh pr create --base main" })).toBe("pr")
    expect(impliedPhase("Bash", { command: "gh pr checks 12 --watch" })).toBe("ci")
    expect(impliedPhase("Bash", { command: "gh run view 1 --log-failed" })).toBeUndefined()
  })
})

describe("MCP problems shown in the app", () => {
  test("a login problem says where the login works", () => {
    expect(mcpProblem("merkl", "needs-auth")).toBe("merkl MCP · sessions: needs a login. Run `claude mcp login merkl` in the monorepo.")
  })

  test("grafana is started, not logged into", () => {
    expect(mcpProblem("grafana", "failed")).toContain("`bun grafana:mcp`")
  })

  test("other states name themselves", () => {
    expect(mcpProblem("merkl", "failed")).toBe("merkl MCP · sessions: failed. Check `claude mcp get merkl` in the monorepo.")
  })
})
