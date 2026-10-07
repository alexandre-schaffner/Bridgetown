import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { repoMcpServers } from "../../src/agent/options.ts"
import { scratchDir } from "../support/tmp.ts"

describe("session MCP servers", () => {
  test("stdio entries in .mcp.json do not drop the http servers sessions need", () => {
    const dir = scratchDir("bt-mcp-")
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
