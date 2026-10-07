import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { codexAgent } from "../../src/agent/codex.ts"
import { codexSessionHome } from "../../src/agent/codex-home.ts"
import type { AgentInput, AgentRequest } from "../../src/agent/protocol.ts"
import { newSession } from "../../src/sessions/new-session.ts"
import { makeAlert } from "../support/records.ts"
import { scratchDir } from "../support/tmp.ts"

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
const fixture = join(import.meta.dir, "../fixtures/codex-server.ts")
const setup = (scenario: string, resume = false) => {
  const home = scratchDir("bt-codex-")
  const cli = join(home, "fake-codex")
  writeFileSync(cli, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ${quote(scenario)} "$@"\n`, { mode: 0o700 })
  const dir = codexSessionHome(home, "s")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "auth.json"), "{}")
  const calls: Array<string> = []
  const undelivered: Array<AgentInput> = []
  const abort = new AbortController()
  const request: AgentRequest = {
    session: { ...newSession(makeAlert(), "s", home, { mode: "manual", provider: "codex", model: "test-model", effort: "high" }), worktree: home, agentSessionId: resume ? "previous" : null },
    home, daemonPort: 47621, abort, resume, prompt: { async *[Symbol.asyncIterator]() { yield { text: "Investigate", reopen: false } } },
    tools: { report: async (_, note) => { calls.push(note) }, ask: async (question) => { calls.push(question); return "prod" }, slackContext: async () => "context" },
    onRefused: (command) => { calls.push(`refused: ${command}`) }, onUndelivered: async (text) => { undelivered.push(text) },
  }
  const audit = () => readFileSync(join(dir, "audit.jsonl"), "utf8")
  return { request, cli, calls, audit, abort, undelivered }
}

describe("Codex investigation adapter", () => {
  test("MCP connection updates replace a pending startup status", async () => {
    const run = setup("mcp")
    const events = await Array.fromAsync(codexAgent(run.request, run.cli))
    expect(events[0]).toMatchObject({ kind: "init", servers: [{ name: "merkl", status: "starting" }] })
    expect(events[1]).toEqual({ kind: "mcp", servers: [{ name: "merkl", status: "connected" }] })
  })
  test("a provider reroute cannot silently substitute the selected model", async () => {
    const run = setup("rerouted")
    await expect(Array.fromAsync(codexAgent(run.request, run.cli))).rejects.toThrow("selected model")
    expect(run.audit()).toContain('"allowProviderModelFallback":false')
  })
  test("streams progress, handles report and ask, refuses unsafe approvals, and resumes", async () => {
    const run = setup("normal", true)
    const events = await Array.fromAsync(codexAgent(run.request, run.cli))
    expect(events.map((e) => e.kind)).toEqual(["init", "text", "result"])
    expect(run.calls).toEqual(["Reading the failure", "Which environment?", "refused: git push origin main"])
    expect(run.audit()).toContain('"method":"thread/resume"')
    expect(run.audit()).toContain('"threadId":"previous"')
    expect(run.audit()).toContain('"decision":"decline"')
    expect(events.at(-1)).toMatchObject({ kind: "result", costUsd: null, error: null, output: { outcome: "needs_human" } })
  })
  test("steers mid-turn input and closes on completion", async () => {
    const run = setup("steer")
    run.request = { ...run.request, prompt: { async *[Symbol.asyncIterator]() { yield { text: "Investigate", reopen: false }; yield { text: "Check staging first", reopen: true } } } }
    await Array.fromAsync(codexAgent(run.request, run.cli))
    expect(run.audit()).toContain('"method":"turn/steer"')
    expect(run.audit()).toContain("Check staging first")
    expect(run.undelivered).toEqual([])
  })
  test("shell-safe commands cannot obtain approval to escape the sandbox", async () => {
    const run = setup("escalation")
    await Array.fromAsync(codexAgent(run.request, run.cli))
    expect(run.audit()).toContain('"approvalPolicy":"never"')
    expect(run.audit()).toContain('"decision":"decline"')
    expect(run.audit()).not.toContain('"decision":"accept"')
    expect(run.calls).toContain("refused: echo changed > /tmp/outside")
  })
  test("a completion racing a follow-up returns the unaccepted input to the runner", async () => {
    const run = setup("race")
    run.request = { ...run.request, prompt: { async *[Symbol.asyncIterator]() { yield { text: "Investigate", reopen: false }; yield { text: "Follow up", reopen: true } } } }
    await Array.fromAsync(codexAgent(run.request, run.cli))
    expect(run.undelivered).toEqual([{ text: "Follow up", reopen: true }])
  })
  test("malformed final output is not treated as a successful structured result", async () => {
    const run = setup("bad-result")
    const events = await Array.fromAsync(codexAgent(run.request, run.cli))
    expect(events.at(-1)).toMatchObject({ output: undefined })
  })
  test("unsupported guards prevent turn start", async () => {
    const run = setup("no-guards")
    await expect(Array.fromAsync(codexAgent(run.request, run.cli))).rejects.toThrow("required tool guards")
    expect(run.audit()).not.toContain('"method":"turn/start"')
  })
  test("stopping a turn kills the process and unblocks the iterator", async () => {
    const run = setup("hold")
    const iterator = codexAgent(run.request, run.cli)
    expect((await iterator.next()).value?.kind).toBe("init")
    const pending = iterator.next()
    setTimeout(() => run.abort.abort(), 100)
    await expect(pending).rejects.toThrow("interrupted")
  })
})
