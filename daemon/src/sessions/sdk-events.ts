import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Schema } from "effect"
import { GHE_REPO } from "../config.ts"
import type { AdapterError } from "../domain/errors.ts"
import { Phase } from "../domain/model.ts"
import type { HubShape } from "../hub.ts"
import { truncate } from "../slack/text.ts"
import { WRITE_TOOLS } from "./confine.ts"
import { commandOf } from "./guard.ts"
import { ownPrUrl, SessionResult } from "./output.ts"
import type { SessionRepoShape } from "./repo.ts"
import { TOOL_SERVER } from "./tools.ts"

/** The schema lists phases in flow order. */
const PHASE_ORDER: ReadonlyArray<Phase> = Phase.literals

/** The phase a tool call implies, for agents that forget to call `report`. Phases only move forward. */
export const impliedPhase = (name: string, input: unknown): Phase | undefined => {
  if (WRITE_TOOLS.includes(name)) return "fix"
  if (name !== "Bash") return undefined
  const command = commandOf(input) ?? ""
  if (/\bgh\s+pr\s+checks\b/.test(command)) return "ci"
  if (/\bgh\s+pr\s+create\b/.test(command)) return "pr"
  if (/\bgit\s+(commit|push)\b|\bsed\s+-i\b/.test(command)) return "fix"
  return undefined
}

export const laterPhase = (current: Phase, next: Phase): boolean => PHASE_ORDER.indexOf(next) > PHASE_ORDER.indexOf(current)

/** One transcript line for a tool call: its name and the argument that says what it does. */
export const describeTool = (name: string, input: unknown): string => {
  const record = typeof input === "object" && input !== null ? Object.fromEntries(Object.entries(input)) : {}
  const pick = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === "string" ? value : undefined
  }
  const detail = pick("command") ?? pick("file_path") ?? pick("pattern") ?? pick("description") ?? pick("url") ?? ""
  return truncate(`${name.replace(/^mcp__/, "")} ${detail}`.trim(), 160)
}

const MCP_PROBLEM_MARK = "MCP · sessions:"

/**
 * What to tell the user about an MCP server sessions couldn't use. merkl and grafana
 * come from the monorepo's `.mcp.json`, so `claude mcp login` only finds them there.
 */
export const mcpProblem = (name: string, status: string): string => {
  if (name === "grafana") return `grafana ${MCP_PROBLEM_MARK} not reachable. Run \`bun grafana:mcp\` in the monorepo.`
  if (status === "needs-auth") return `${name} ${MCP_PROBLEM_MARK} needs a login. Run \`claude mcp login ${name}\` in the monorepo.`
  return `${name} ${MCP_PROBLEM_MARK} ${status}. Check \`claude mcp get ${name}\` in the monorepo.`
}

export const isMcpProblem = (error: string | null): boolean => error?.includes(MCP_PROBLEM_MARK) === true

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

/** Turns one SDK message into transcript lines, status, and (for the result) the end of the turn. */
export const handleMessage = (id: string, message: SDKMessage, sink: EventSink): Effect.Effect<void, AdapterError> =>
  Effect.gen(function* () {
    const { repo, hub } = sink
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          yield* repo.patch(id, { claudeSessionId: message.session_id })
          const servers = message.mcp_servers.filter((server) => server.name !== TOOL_SERVER)
          const down = servers.filter((server) => server.status !== "connected")
          yield* repo.log(
            id,
            down.length === 0 ? "status" : "error",
            `MCP: ${servers.map((server) => `${server.name} ${server.status}`).join(", ") || "none configured"}`,
          )
          for (const server of down) yield* hub.patchStatus({ error: mcpProblem(server.name, server.status) })
          // Every server connected: a problem an earlier session reported is fixed now.
          if (down.length === 0 && isMcpProblem((yield* hub.status).error)) yield* hub.patchStatus({ error: null })
        }
        return
      case "assistant":
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim() !== "") yield* repo.log(id, "text", block.text, { activity: true })
          if (block.type === "tool_use" && !block.name.startsWith(`mcp__${TOOL_SERVER}__`) && block.name !== "StructuredOutput") {
            yield* repo.log(id, "tool", describeTool(block.name, block.input), { activity: true })
            const phase = impliedPhase(block.name, block.input)
            if (phase !== undefined) {
              yield* repo.modify(id, (current) => (laterPhase(current.phase, phase) ? { ...current, phase } : undefined))
            }
          }
        }
        return
      case "result": {
        sink.closeInput()
        // What the turn cost is recorded even when the session was stopped meanwhile.
        yield* repo.modify(id, (current) => ({ ...current, costUsd: current.costUsd + message.total_cost_usd }), { evenIfFinished: true })
        if (message.subtype !== "success") {
          yield* repo.log(id, "error", message.errors.join("\n") || message.subtype)
          return yield* sink.onEnd({ _tag: "Failed", reason: `Agent stopped: ${message.subtype}` })
        }
        yield* repo.log(id, "result", message.result)
        const decoded = Schema.decodeUnknownOption(SessionResult)(message.structured_output)
        if (decoded._tag === "None") return yield* sink.onEnd({ _tag: "Failed", reason: "Agent finished without a structured result" })
        const prUrl = ownPrUrl(decoded.value.prUrl)
        if (decoded.value.prUrl !== null && prUrl === null) yield* repo.log(id, "error", `Ignored the PR link ${truncate(decoded.value.prUrl, 200)}: not a pull request on ${GHE_REPO}`)
        return yield* sink.onEnd({ _tag: "Result", result: { ...decoded.value, prUrl } })
      }
      default:
        return
    }
  })
