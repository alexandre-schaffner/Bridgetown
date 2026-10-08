/** A scripted app-server exercises the actual subprocess and JSON-RPC transport without inference. */
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Schema } from "effect"
import { RESULT } from "../support/agent.ts"

const scenario = process.argv[2]
const Envelope = Schema.Struct({ id: Schema.optional(Schema.Union([Schema.String, Schema.Number])), method: Schema.optional(Schema.String), params: Schema.optional(Schema.Unknown), result: Schema.optional(Schema.Unknown) })
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
const event = (method: string, params: unknown) => send({ method, params })
const complete = () => {
  event("item/completed", { item: { type: "agentMessage", text: scenario === "bad-result" ? "not-json" : JSON.stringify(RESULT), phase: "final_answer" } })
  event("turn/completed", { turn: { status: "completed", error: null } })
}
const lines = createInterface({ input: process.stdin })
lines.on("line", (line) => {
  const request = Schema.decodeUnknownSync(Schema.fromJsonString(Envelope))(line)
  const audit = process.env.CODEX_HOME
  if (audit !== undefined) appendFileSync(join(audit, "audit.jsonl"), `${line}\n`)
  switch (request.method) {
    case "initialize": send({ id: request.id, result: {} }); break
    case "initialized": break
    case "config/read": {
      const config = Bun.TOML.parse(readFileSync(join(process.env.CODEX_HOME ?? "", "config.toml"), "utf8"))
      send({ id: request.id, result: { config: { ...config, ...(scenario === "no-guards" ? { hooks: {} } : {}) } } })
      break
    }
    case "thread/start": case "thread/resume": send({ id: request.id, result: { thread: { id: "codex-conversation" } } }); break
    case "mcpServerStatus/list": send({ id: request.id, result: { data: scenario === "mcp" ? [{ name: "merkl", runtimeStatus: "starting" }] : [], nextCursor: null } }); break
    case "turn/start":
      send({ id: request.id, result: { turn: { id: "turn-1" } } })
      if (scenario === "hold") break
      if (scenario === "rerouted") { event("model/rerouted", {}); break }
      if (scenario === "bad-result" || scenario === "race") { complete(); break }
      if (scenario === "mcp") event("mcpServer/startupStatus/updated", { threadId: "codex-conversation", name: "merkl", status: "ready", failureReason: null })
      event("item/completed", { item: { type: "agentMessage", text: "Investigating", phase: "commentary" } })
      send({ id: "report", method: "item/tool/call", params: { tool: "report", arguments: { phase: "diagnose", note: "Reading the failure" } } })
      break
    case "turn/steer":
      if (scenario === "race") send({ id: request.id, error: { code: -32000, message: "No active turn" } })
      else { send({ id: request.id, result: { turnId: "turn-1" } }); complete() }
      break
    default:
      if (request.id === "report") send({ id: "ask", method: "item/tool/call", params: { tool: "ask", arguments: { question: "Which environment?", options: ["prod", "staging"] } } })
      if (request.id === "ask") {
        send({ id: "approval", method: "item/commandExecution/requestApproval", params: { command: scenario === "escalation" ? "echo changed > /tmp/outside" : "git push origin main", cwd: process.env.CODEX_HOME, additionalPermissions: null } })
      }
      if (request.id === "approval" && scenario !== "steer") complete()
  }
})
