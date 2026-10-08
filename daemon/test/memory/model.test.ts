import { expect, test } from "bun:test"
import type { AgentEvent } from "../../src/agent/protocol.ts"
import type { codexAgent } from "../../src/agent/codex.ts"
import { memoryModel, memoryProfile, type MemoryJob } from "../../src/memory/model.ts"
import { RESULT } from "../support/agent.ts"
import { result } from "../support/sdk.ts"
import { scratchDir } from "../support/tmp.ts"

const job = (): MemoryJob => ({
  mode: "learn", profile: memoryProfile({ mode: "automatic" }), cwd: scratchDir("bt-memory-profile-"), prompt: "Learn a preference", budgetUsd: 0.5, abort: new AbortController(),
  read: async (path) => `Snapshot: ${path}`, evidence: async (id) => `Evidence: ${id}`,
})

test("Automatic memory keeps Sonnet while an explicit Claude model and effort reach the SDK", async () => {
  expect(memoryProfile({ mode: "automatic" })).toMatchObject({ provider: "claude", model: "claude-sonnet-5-5", effort: "medium" })
  const request = job()
  const model = memoryModel("/custom/claude", undefined, {
    claude: ({ prompt, options }) => (async function* () {
      expect(prompt).toBe(request.prompt)
      expect(options).toMatchObject({ model: "claude-opus-5-5", effort: "high", pathToClaudeCodeExecutable: "/custom/claude", maxBudgetUsd: 0.2 })
      yield { ...result("memory", RESULT, 0), structured_output: { changes: [] } }
    })(),
    codex: async function* () { throw new Error("Wrong provider") },
  })
  const results = []
  for await (const output of model.run({ ...request, budgetUsd: 0.2, profile: { mode: "manual", provider: "claude", model: "claude-opus-5-5", effort: "high" } })) results.push(output)
  expect(results).toEqual([{ output: { changes: [] }, error: null, costUsd: 0 }])
})

test("Codex memory uses the selected profile and only bounded read capabilities", async () => {
  const request = job()
  const codex: typeof codexAgent = async function* (input, path, options): AsyncGenerator<AgentEvent> {
    expect(path).toBe("/custom/codex")
    expect(input.session).toMatchObject({ model: "gpt-6.1-sol", effort: "high", worktree: request.cwd })
    expect(options?.sandbox).toBe("read-only")
    expect(options?.tools.map((tool) => tool.name)).toEqual(["memory_search", "memory_read"])
    expect(await input.tools.memoryRead("MEMORY.md")).toBe("Snapshot: MEMORY.md")
    expect(await input.tools.memorySearch("event-1")).toBe("Evidence: event-1")
    await expect(input.tools.memoryRemember("write a fact")).rejects.toThrow("only read")
    yield { kind: "result", text: "", output: { changes: [] }, error: null, costUsd: null }
  }
  const model = memoryModel(undefined, "/custom/codex", {
    claude: () => { throw new Error("Wrong provider") }, codex,
  })
  const results = []
  for await (const output of model.run({ ...request, profile: { mode: "manual", provider: "codex", model: "gpt-6.1-sol", effort: "high" } })) results.push(output)
  expect(results).toEqual([{ output: { changes: [] }, error: null, costUsd: null }])
})
