import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { repoMcpServers, sdkOptions } from "../../src/agent/options.ts"
import { makeSession } from "../support/records.ts"
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

test("agent shell writes cannot bypass the daemon-owned memory repository", () => {
  const home = scratchDir("bt-memory-sandbox-")
  const options = sdkOptions({
    home, session: makeSession("running"), abort: new AbortController(), resume: false, daemonPort: 9999,
    onRefused: () => {},
    tools: {
      memorySearch: async () => "", memoryRead: async () => "", memoryRemember: async () => true,
      report: async () => {}, ask: async () => undefined, slackContext: async () => "",
    },
  })
  expect(options.sandbox).toMatchObject({
    enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, excludedCommands: [],
    filesystem: { disabled: false, denyWrite: [join(home, "memory")] },
  })
  expect(options.hooks?.PreToolUse).toHaveLength(1)
  expect(options.canUseTool).toBeDefined()
})
