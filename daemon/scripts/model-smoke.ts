/** Checks installed model discovery and Codex guard configuration without running inference. */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { Models, ModelsLive } from "../src/agent/models.ts"
import { codexHookCommand, hasCodexGuards, prepareCodexHome } from "../src/agent/codex-home.ts"
import { CODEX_TOOLS } from "../src/agent/codex.ts"
import { CodexRpc } from "../src/agent/codex-rpc.ts"
import type { AgentRequest } from "../src/agent/protocol.ts"
import { newSession } from "../src/sessions/new-session.ts"
import { makeAlert } from "../test/support/records.ts"

const catalog = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* Models).catalog(true) }).pipe(Effect.provide(ModelsLive({ claudePath: Bun.which("claude") ?? undefined, codexPath: undefined }))))
for (const provider of catalog.providers) {
  if (provider.error !== null) throw new Error(`${provider.provider}: ${provider.error}`)
  console.log(`${provider.provider}: ${provider.models.length} models detected`)
}
const home = await mkdtemp(join(tmpdir(), "bt-model-smoke-"))
const abort = new AbortController()
const timer = setTimeout(() => abort.abort(), 15_000)
let rpc: CodexRpc | undefined
try {
  const request: AgentRequest = {
    session: { ...newSession(makeAlert(), "smoke", home), worktree: home, provider: "codex" }, home, daemonPort: 47621, abort, resume: false,
    prompt: { async *[Symbol.asyncIterator]() {} }, onRefused: () => {}, onUndelivered: async () => {},
    tools: { report: async () => {}, ask: async () => undefined, slackContext: async () => "" },
  }
  const dir = prepareCodexHome(request)
  rpc = new CodexRpc([Bun.which("codex") ?? "codex", "--dangerously-bypass-hook-trust", "app-server", "--listen", "stdio://"], abort.signal, { CODEX_HOME: dir }, dir)
  await rpc.initialize()
  const response = Schema.decodeUnknownSync(Schema.Struct({ config: Schema.Record(Schema.String, Schema.Unknown) }))(await rpc.request("config/read", { includeLayers: false }))
  if (!hasCodexGuards(response.config, request)) throw new Error("Codex did not load the required hooks")
  console.log("codex: required guard configuration loaded")
  const model = catalog.providers.find((p) => p.provider === "codex")?.models[0]?.id
  Schema.decodeUnknownSync(Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) }))(await rpc.request("thread/start", {
    cwd: home, model, sandbox: "workspace-write", allowProviderModelFallback: false, dynamicTools: CODEX_TOOLS,
    config: { mcp_servers: {}, sandbox_workspace_write: { network_access: true } },
  }))
  console.log("codex: thread configured without inference")
  for (const [command, decision] of [["git status", "allow"], ["git push origin main", "deny"]]) {
    const hook = Bun.spawn(["/bin/sh", "-c", codexHookCommand(request)], { cwd: home, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    hook.stdin.write(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: home }))
    hook.stdin.end()
    const verdict = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ hookSpecificOutput: Schema.Struct({ permissionDecision: Schema.String }) })))(await new Response(hook.stdout).text())
    if (await hook.exited !== 0 || verdict.hookSpecificOutput.permissionDecision !== decision) throw new Error(`The guard command failed to ${decision} ${command}`)
  }
  console.log("codex: hook runner allowed a read and denied a protected branch push")
} finally {
  clearTimeout(timer)
  rpc?.close()
  await rm(home, { recursive: true, force: true })
}
