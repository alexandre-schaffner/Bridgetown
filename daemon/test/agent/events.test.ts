import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { impliedPhase } from "../../src/agent/events.ts"
import { repoMcpServers } from "../../src/agent/options.ts"
import { SESSION_RESULT_JSON_SCHEMA, SessionResult } from "../../src/agent/result.ts"
import { ownPrUrl } from "../../src/ship/pr.ts"
import { scratchDir } from "../support/tmp.ts"

describe("implied phase", () => {
  test("edits mean fixing, gh pr create means pr", () => {
    expect(impliedPhase("Edit", { file_path: "x" })).toBe("fix")
    expect(impliedPhase("Bash", { command: "GH_HOST=x gh pr create --base main" })).toBe("pr")
    expect(impliedPhase("Bash", { command: "gh pr checks 12 --watch" })).toBe("ci")
    expect(impliedPhase("Bash", { command: "gh run view 1 --log-failed" })).toBeUndefined()
  })
})

describe("the agent's PR link", () => {
  const OWN = "https://nocturlab.ghe.com/Merkl/monorepo/pull/3401"

  test("is the PR's own URL when it points into a PR on the repo Bridgetown ships", () => {
    for (const link of [OWN, `${OWN}/`, `${OWN}/files`, `${OWN}#issuecomment-1`, `${OWN}?w=1`]) expect(ownPrUrl(link)).toBe(OWN)
  })

  test("is no PR anywhere else", () => {
    for (const link of [
      "https://github.com/Merkl/monorepo/pull/3401",
      "https://nocturlab.ghe.com/Merkl/other/pull/1",
      "https://nocturlab.ghe.com/Merkl/monorepo/pull/3401x",
      "https://nocturlab.ghe.com/Merkl/monorepo/issues/3401",
      "https://nocturlab.ghe.com.evil.com/Merkl/monorepo/pull/1",
      "http://nocturlab.ghe.com/Merkl/monorepo/pull/1",
      null,
      undefined,
    ]) {
      expect(ownPrUrl(link)).toBeNull()
    }
  })
})

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

describe("the session result's JSON schema", () => {
  test("is strict and asks for exactly the fields SessionResult decodes", () => {
    expect(SESSION_RESULT_JSON_SCHEMA.additionalProperties).toBe(false)
    const keys = (record: object): Array<string> => Object.keys(record).sort()
    const required: ReadonlyArray<string> = SESSION_RESULT_JSON_SCHEMA.required
    expect([...required].sort()).toEqual(keys(SESSION_RESULT_JSON_SCHEMA.properties))
    expect(keys(SESSION_RESULT_JSON_SCHEMA.properties)).toEqual(keys(SessionResult.fields))
  })
})
