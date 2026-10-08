import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent } from "../../src/agent/protocol.ts"
import { codexAgent } from "../../src/agent/codex.ts"
import { memoryModel, memoryProfile, type MemoryJob } from "../../src/memory/model.ts"
import { RESULT } from "../support/agent.ts"
import { result } from "../support/sdk.ts"
import { scratchDir } from "../support/tmp.ts"

const job = (): MemoryJob => ({
  mode: "learn", profile: memoryProfile({ mode: "automatic" }), cwd: scratchDir("bt-memory-profile-"), prompt: "Learn a preference", budgetUsd: 0.5, abort: new AbortController(),
  read: async (path) => `Snapshot: ${path}`, evidence: async (id) => `Evidence: ${id}`,
})

for (const scenario of ["error-retryable", "error-fatal", "error-no-detail"]) test(`Codex memory consumes the terminal result after ${scenario}`, async () => {
  const request = job()
  const cli = join(request.cwd, "fake-codex")
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
  writeFileSync(cli, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "../fixtures/codex-server.ts"))} ${scenario} "$@"\n`, { mode: 0o700 })
  const invoke: typeof codexAgent = (input, path, options) => {
    const dir = input.session.agentConfigDir
    if (dir === null) throw new Error("The memory adapter must isolate its Codex configuration")
    writeFileSync(join(dir, "auth.json"), "{}")
    return codexAgent(input, path, options)
  }
  const model = memoryModel(undefined, cli, { claude: () => { throw new Error("Wrong provider") }, codex: invoke })
  const output = await Array.fromAsync(model.run({ ...request, profile: { mode: "manual", provider: "codex", model: "test-model", effort: null } }))
  expect(output).toHaveLength(1)
  expect(output[0]).toMatchObject({ output: { changes: [] }, error: scenario === "error-retryable" ? null : scenario === "error-fatal"
    ? "Memory model failed: Usage quota exhausted: retry after the reset" : "Memory model failed: Usage quota exhausted" })
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
