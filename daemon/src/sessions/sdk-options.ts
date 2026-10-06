import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { CanUseTool, McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk"
import { Schema } from "effect"
import { GH_HOST } from "../config.ts"
import type { Session } from "../domain/session.ts"
import { childEnv } from "../secrets.ts"
import { readScript } from "./guard.ts"
import { SESSION_RESULT_JSON_SCHEMA } from "./output.ts"
import { type ToolGuard, toolGuard, toolRefusal } from "./tool-guard.ts"
import { makeToolServer, TOOL_SERVER, type ToolCallbacks } from "./tools.ts"

const MAX_TURNS = 400

/** Only the servers sessions need from the repo's `.mcp.json`, so an unrelated broken server cannot fail a run. */
const SESSION_MCP_SERVERS = ["merkl", "grafana"]

const HttpServer = Schema.Struct({ type: Schema.Literal("http"), url: Schema.String })
const McpFile = Schema.Struct({ mcpServers: Schema.Record(Schema.String, Schema.Unknown) })

/**
 * Each wanted server is decoded on its own: the repo's file also lists stdio
 * servers of other shapes, and one of those must not drop the ones we need.
 */
export const repoMcpServers = (repoPath: string): Record<string, McpServerConfig> => {
  const path = join(repoPath, ".mcp.json")
  if (!existsSync(path)) return {}
  let servers: Record<string, unknown>
  try {
    servers = Schema.decodeUnknownSync(McpFile)(JSON.parse(readFileSync(path, "utf8"))).mcpServers
  } catch {
    return {}
  }
  const out: Record<string, McpServerConfig> = {}
  for (const name of SESSION_MCP_SERVERS) {
    const server = Schema.decodeUnknownOption(HttpServer)(servers[name], { onExcessProperty: "ignore" })
    if (server._tag === "Some") out[name] = { type: "http", url: server.value.url }
  }
  return out
}

/** The agent's environment: no daemon credential or config, plus what sessions need. */
export const sessionEnv = (env: Record<string, string | undefined>, sessionId: string): Record<string, string> => ({
  ...childEnv(env),
  GH_HOST,
  BRIDGETOWN_SESSION: sessionId,
})

export interface TurnSetup {
  readonly session: Session
  readonly abort: AbortController
  /** Resume the agent's conversation instead of starting a new one. */
  readonly resume: boolean
  readonly tools: ToolCallbacks
  /** Records a refused command or write in the transcript. */
  readonly onRefused: (what: string, reason: string) => void
  /** The daemon's API port, which the session may not reach. */
  readonly daemonPort: number
}

/**
 * The built-in tools a session may use, named explicitly. An allowlist, not the
 * `claude_code` preset: the preset hands the running CLI every tool it ships, and
 * a new one (Monitor, Cron*, RemoteTrigger, Workflow…) can run shell commands or
 * reach the network outside the gate. Only these appear, so nothing is unguarded.
 */
const SESSION_TOOLS: ReadonlyArray<string> = ["Bash", "Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit", "WebSearch", "WebFetch", "TodoWrite"]

/**
 * `Task` is injected by the CLI regardless of the tools allowlist, and a subagent
 * can run `isolation: "remote"` entirely outside this process and its gate. A
 * single session investigates one alert and opens one PR; it needs no subagent,
 * so `Task` is removed rather than left as an escape hatch.
 */
const SESSION_DISALLOWED_TOOLS: ReadonlyArray<string> = ["Task"]

/** The SDK options for one turn: guards, write confinement, MCP servers, structured output, a scrubbed env. */
export const sdkOptions = ({ session, abort, resume, tools, onRefused, daemonPort }: TurnSetup): Options => {
  const guard: ToolGuard = {
    branch: session.branch ?? "",
    cwd: session.worktree ?? session.repoPath,
    daemonPort,
    readFile: readScript,
    worktree: session.worktree,
  }
  // Nobody is there to answer a permission prompt, so everything the gate does not refuse runs.
  // The matcher-less PreToolUse hook is the real gate (it runs before allow rules and permission modes); canUseTool is the second, for tools a permission flow asks about.
  const canUseTool: CanUseTool = async (toolName, input) => {
    const reason = toolRefusal(guard, toolName, input)
    if (reason === undefined) return { behavior: "allow", updatedInput: input }
    onRefused(input.command ? String(input.command) : toolName, reason)
    return { behavior: "deny", message: reason }
  }
  return {
    ...(session.worktree === null ? {} : { cwd: session.worktree }),
    model: session.model,
    effort: session.effort,
    abortController: abort,
    systemPrompt: { type: "preset", preset: "claude_code" },
    tools: [...SESSION_TOOLS],
    disallowedTools: [...SESSION_DISALLOWED_TOOLS],
    settingSources: ["user", "project", "local"],
    permissionMode: "acceptEdits",
    canUseTool,
    strictMcpConfig: true,
    mcpServers: { ...repoMcpServers(session.repoPath), [TOOL_SERVER]: makeToolServer(tools) },
    hooks: {
      PreToolUse: [{ hooks: [toolGuard(guard, onRefused)] }],
    },
    outputFormat: { type: "json_schema", schema: SESSION_RESULT_JSON_SCHEMA },
    persistSession: true,
    maxTurns: MAX_TURNS,
    env: sessionEnv(process.env, session.id),
    ...(resume && session.claudeSessionId !== null ? { resume: session.claudeSessionId } : {}),
  }
}
