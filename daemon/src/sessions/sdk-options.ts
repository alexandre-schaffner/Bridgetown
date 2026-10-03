import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { CanUseTool, McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk"
import { Schema } from "effect"
import { daemonPort, GH_HOST } from "../config.ts"
import type { Session } from "../domain/model.ts"
import { childEnv } from "../secrets.ts"
import { writeGuard, writeRefusal, WRITE_TOOLS } from "./confine.ts"
import { bashGuard, type GuardContext, readScript, refusal } from "./guard.ts"
import { SESSION_RESULT_JSON_SCHEMA } from "./output.ts"
import { makeToolServer, TOOL_SERVER, type ToolCallbacks } from "./tools.ts"

const MAX_TURNS = 400

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
const effortOf = (value: string) => EFFORTS.find((effort) => effort === value) ?? "high"

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

/**
 * A compiled daemon has no SDK-bundled CLI next to it, so it runs the user's own
 * `claude` (which also carries their login). From source the SDK's bundled CLI is used.
 */
const claudeExecutable = (): string | undefined =>
  process.env.BRIDGETOWN_CLAUDE_PATH ?? (import.meta.url.includes("$bunfs") ? (Bun.which("claude") ?? undefined) : undefined)

const withExecutable = (path: string | undefined): { pathToClaudeCodeExecutable?: string } =>
  path === undefined ? {} : { pathToClaudeCodeExecutable: path }

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
}

/** The SDK options for one turn: guards, write confinement, MCP servers, structured output, a scrubbed env. */
export const sdkOptions = ({ session, abort, resume, tools, onRefused }: TurnSetup): Options => {
  const guard: GuardContext = {
    branch: session.branch ?? "",
    cwd: session.worktree ?? session.repoPath,
    daemonPort: daemonPort(),
    readFile: readScript,
  }
  // Everything the guards do not refuse runs: nobody is there to answer a permission prompt.
  // The PreToolUse hooks are the real gate (they run before allow rules and permission modes); this is the second.
  const canUseTool: CanUseTool = async (toolName, input) => {
    if (toolName === "Bash" && typeof input.command === "string") {
      const reason = refusal(input.command, guard)
      if (reason !== undefined) return { behavior: "deny", message: reason }
    }
    const reason = writeRefusal(toolName, input, session.worktree)
    if (reason !== undefined) return { behavior: "deny", message: reason }
    return { behavior: "allow", updatedInput: input }
  }
  return {
    ...(session.worktree === null ? {} : { cwd: session.worktree }),
    model: session.model,
    effort: effortOf(session.effort),
    abortController: abort,
    systemPrompt: { type: "preset", preset: "claude_code" },
    tools: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    permissionMode: "acceptEdits",
    canUseTool,
    strictMcpConfig: true,
    mcpServers: { ...repoMcpServers(session.repoPath), [TOOL_SERVER]: makeToolServer(tools) },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [bashGuard(guard, onRefused)] },
        { matcher: WRITE_TOOLS.join("|"), hooks: [writeGuard(session.worktree, onRefused)] },
      ],
    },
    outputFormat: { type: "json_schema", schema: SESSION_RESULT_JSON_SCHEMA },
    persistSession: true,
    maxTurns: MAX_TURNS,
    ...withExecutable(claudeExecutable()),
    env: sessionEnv(process.env, session.id),
    ...(resume && session.claudeSessionId !== null ? { resume: session.claudeSessionId } : {}),
  }
}
