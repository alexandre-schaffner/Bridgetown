import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { impliedPhase } from "../src/sessions/sdk-events.ts"
import { repoMcpServers } from "../src/sessions/sdk-options.ts"

describe("implied phase", () => {
  test("edits mean fixing, gh pr create means pr", () => {
    expect(impliedPhase("Edit", { file_path: "x" })).toBe("fix")
    expect(impliedPhase("Bash", { command: "GH_HOST=x gh pr create --base main" })).toBe("pr")
    expect(impliedPhase("Bash", { command: "gh pr checks 12 --watch" })).toBe("ci")
    expect(impliedPhase("Bash", { command: "gh run view 1 --log-failed" })).toBeUndefined()
  })
})

describe("session MCP servers", () => {
  test("stdio entries in .mcp.json do not drop the http servers sessions need", () => {
    const dir = mkdtempSync(join(tmpdir(), "bt-mcp-"))
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          merkl: { type: "http", url: "https://mcp.merkl.xyz/mcp" },
          "sequential-thinking": { type: "stdio", command: "bun", args: ["x", "pkg"] },
          grafana: { type: "http", url: "http://localhost:8000/mcp" },
          mixpanel: { type: "http", url: "https://mcp-eu.mixpanel.com/mcp" },
        },
      }),
    )
    expect(repoMcpServers(dir)).toEqual({
      merkl: { type: "http", url: "https://mcp.merkl.xyz/mcp" },
      grafana: { type: "http", url: "http://localhost:8000/mcp" },
    })
  })
})
