import { Effect, Schema } from "effect"
import { GHE_REPO } from "../config.ts"
import type { AdapterError } from "../domain/errors.ts"
import type { AgentProvider } from "../domain/models.ts"
import { Phase } from "../domain/session.ts"
import { commandOf } from "../guard/bash.ts"
import { WRITE_TOOLS } from "../guard/confine.ts"
import type { HubShape } from "../hub.ts"
import { truncate } from "../lib/text.ts"
import type { SessionRepoShape } from "../sessions/repo.ts"
import { ownPrUrl } from "../ship/pr.ts"
import type { AgentEvent } from "./protocol.ts"
import { SessionResult } from "./result.ts"
import { TOOL_SERVER } from "./tools.ts"
import { redactSecrets } from "../security/policy.ts"

/** The schema lists phases in flow order. */
const PHASE_ORDER: ReadonlyArray<Phase> = Phase.literals

/** The phase a tool call implies, for agents that forget to call `report`. Phases only move forward. */
export const impliedPhase = (name: string, input: unknown): Phase | undefined => {
  if (name.endsWith("bt_submit_fix")) return "pr"
  if (name.endsWith("bt_write_file")) return "fix"
  if (WRITE_TOOLS.includes(name)) return "fix"
  if (name !== "Bash") return undefined
  const command = commandOf(input) ?? ""
  if (/\bgh\s+pr\s+checks\b/.test(command)) return "ci"
  if (/\bgh\s+pr\s+create\b/.test(command)) return "pr"
  if (/\bgit\s+(commit|push)\b|\bsed\s+-i\b/.test(command)) return "fix"
  return undefined
}

const laterPhase = (current: Phase, next: Phase): boolean => PHASE_ORDER.indexOf(next) > PHASE_ORDER.indexOf(current)

/** One transcript line for a tool call: its name and the argument that says what it does. */
const describeTool = (name: string, input: unknown): string => {
  const record = typeof input === "object" && input !== null ? Object.fromEntries(Object.entries(input)) : {}
  const pick = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === "string" ? value : undefined
  }
  const detail = pick("command") ?? pick("path") ?? pick("title") ?? pick("file_path") ?? pick("pattern") ?? pick("description") ?? pick("url") ?? ""
  return truncate(`${name.replace(/^mcp__/, "")} ${detail}`.trim(), 160)
}

/**
 * What to tell the user about an MCP server sessions couldn't use. merkl and grafana
 * come from the monorepo's `.mcp.json`, so `claude mcp login` only finds them there.
 */
export const mcpProblem = (name: string, status: string, provider: AgentProvider = "claude", configDir?: string | null): string => {
  if (name === "grafana") return "grafana MCP · sessions: not reachable. Run `bun grafana:mcp` in the monorepo."
  if (provider === "codex") {
    const command = `${configDir ? `CODEX_HOME='${configDir.replaceAll("'", `'\\''`)}' ` : ""}codex mcp`
    return status === "needs-auth"
      ? `${name} MCP · sessions: needs a login. Run \`${command} login ${name}\`.`
      : `${name} MCP · sessions: ${status}. Check \`${command} get ${name}\`.`
  }
  if (status === "needs-auth") return `${name} MCP · sessions: needs a login. Run \`claude mcp login ${name}\` in the monorepo.`
  return `${name} MCP · sessions: ${status}. Check \`claude mcp get ${name}\` in the monorepo.`
}

/** How a turn ended: a structured result to act on, or a reason it cannot be trusted. */
export type TurnEnd =
  | { readonly _tag: "Result"; readonly result: SessionResult }
  | { readonly _tag: "Failed"; readonly reason: string }

export interface EventSink {
  readonly repo: SessionRepoShape
  readonly hub: HubShape
  /** Ends the query's input, so the CLI exits once it has sent its result. */
  readonly closeInput: () => void
  readonly onEnd: (end: TurnEnd) => Effect.Effect<void, AdapterError>
}

const reportMcp = (id: string, servers: ReadonlyArray<{ readonly name: string; readonly status: string }>, { repo, hub }: EventSink) =>
  Effect.gen(function* () {
    const wanted = servers.filter((server) => server.name !== TOOL_SERVER)
    const down = wanted.filter((server) => server.status !== "connected" && server.status !== "starting")
    yield* repo.log(id, down.length === 0 ? "status" : "error", `MCP: ${wanted.map((s) => `${s.name} ${s.status}`).join(", ") || "none configured"}`)
    const session = down.length === 0 ? undefined : yield* repo.get(id)
    yield* hub.problem("mcp", down.length === 0 ? null : down.map((s) => mcpProblem(s.name, s.status, session?.provider, session?.agentConfigDir)).join(" "))
  })

/** Applies normalized provider events to the session. */
export const handleEvent = (id: string, event: AgentEvent, sink: EventSink): Effect.Effect<void, AdapterError> =>
  Effect.gen(function* () {
    const { repo } = sink
    switch (event.kind) {
      case "init": {
        yield* repo.patch(id, { agentSessionId: event.conversationId, agentConfigDir: event.configDir ?? null })
        return yield* reportMcp(id, event.servers, sink)
      }
      case "mcp": return yield* reportMcp(id, event.servers, sink)
      case "text":
        if (event.text.trim() !== "") yield* repo.log(id, "text", redactSecrets(event.text), { activity: true })
        return
      case "tool": {
        const prefix = `mcp__${TOOL_SERVER}__`
        const name = event.name.startsWith(prefix) ? event.name.slice(prefix.length) : event.name
        if (["report", "ask", "slack_context", "StructuredOutput"].includes(name)) return
        yield* repo.log(id, "tool", redactSecrets(describeTool(name, event.input)), { activity: true })
        const phase = impliedPhase(name, event.input)
        if (phase !== undefined) yield* repo.modify(id, (s) => laterPhase(s.phase, phase) ? { ...s, phase } : undefined)
        return
      }
      case "error":
        yield* repo.log(id, "error", redactSecrets(event.text))
        return
      case "result": {
        sink.closeInput()
        yield* repo.modify(id, (s) => ({ ...s, costUsd: event.costUsd === null || s.costUsd === null ? null : s.costUsd + event.costUsd }), { evenIfFinished: true })
        if (event.error !== null) {
          yield* repo.log(id, "error", redactSecrets(event.error))
          return yield* sink.onEnd({ _tag: "Failed", reason: `Agent stopped: ${redactSecrets(event.error)}` })
        }
        yield* repo.log(id, "result", redactSecrets(event.text))
        const decoded = Schema.decodeUnknownOption(SessionResult)(event.output)
        if (decoded._tag === "None") return yield* sink.onEnd({ _tag: "Failed", reason: "Agent finished without a structured result" })
        if (redactSecrets(JSON.stringify(decoded.value)) !== JSON.stringify(decoded.value)) return yield* sink.onEnd({ _tag: "Failed", reason: "Agent result contains credential-like content; publication was refused" })
        const prUrl = ownPrUrl(decoded.value.prUrl)
        if (decoded.value.prUrl !== null && prUrl === null) yield* repo.log(id, "error", `Ignored the PR link ${truncate(redactSecrets(decoded.value.prUrl), 200)}: not a pull request on ${GHE_REPO}`)
        return yield* sink.onEnd({ _tag: "Result", result: { ...decoded.value, prUrl } })
      }
    }
  })
