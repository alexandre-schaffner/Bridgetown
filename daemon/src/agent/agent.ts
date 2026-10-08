import { realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { type Options, query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Context, Layer } from "effect"

import type { AgentEvent, AgentRequest } from "./protocol.ts"
import { sdkOptions } from "./options.ts"
import { codexAgent } from "./codex.ts"
import { makeBroker } from "../security/broker.ts"

/** The Claude Agent SDK's `query`, as a service so tests can run turns without a CLI. */
export interface AgentShape {
  readonly run: (request: AgentRequest) => AsyncIterable<AgentEvent>
}

export class Agent extends Context.Service<Agent, AgentShape>()("Agent") {}

/**
 * A compiled daemon has no SDK-bundled CLI next to it, so it runs the user's own `claude` (which also carries their
 * login); from source the SDK's bundled CLI runs. `claudePath` (`BRIDGETOWN_CLAUDE_PATH`) overrides both.
 */
export const claudeExecutable = (claudePath: string | undefined): string | undefined =>
  claudePath ?? (import.meta.url.includes("$bunfs") ? (Bun.which("claude") ?? undefined) : undefined)

/** Converts only at the Claude boundary, including odd messages from a user's CLI. */
export function* claudeEvents(message: SDKMessage): Generator<AgentEvent> {
  try {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") yield { kind: "init", conversationId: message.session_id, servers: message.mcp_servers.map((server) => ({ name: server.name, status: server.status })) }
        return
      case "assistant":
        for (const block of message.message.content) {
          if (block.type === "text") yield { kind: "text", text: block.text }
          if (block.type === "tool_use") yield { kind: "tool", name: block.name, input: block.input }
        }
        return
      case "result":
        yield { kind: "result", text: message.subtype === "success" ? message.result : "", output: message.subtype === "success" ? message.structured_output : undefined,
          costUsd: message.total_cost_usd, error: message.subtype === "success" ? null : message.errors.join("\n") || message.subtype }
        return
    }
  } catch (cause) {
    yield { kind: "error", text: `Skipped an SDK ${message.type} message: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
}

/** Used by the real Claude SDK and scripted SDKs in tests. */
export const claudeAgent = (invoke: (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>): AgentShape => ({
  run: async function* (request) {
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      let first = true
      for await (const input of request.prompt) {
        yield { type: "user", message: { role: "user", content: input.text }, parent_tool_use_id: null, ...(first ? {} : { priority: "next" }) }
        first = false
      }
    }
    for await (const message of invoke({ prompt: prompt(), options: sdkOptions(request) })) yield* claudeEvents(message)
  },
})

export const AgentLive = (claudePath: string | undefined, codexPath?: string) => {
  const claude = claudeAgent(({ prompt, options }) => {
    const executable = claudeExecutable(claudePath)
    return query({ prompt, options: executable === undefined ? options : { ...options, pathToClaudeCodeExecutable: executable } })
  })
  return Layer.succeed(Agent)({ run: (request) => {
    const brokered = { ...request, tools: { ...request.tools, broker: makeBroker(request) } }
    return request.session.provider === "codex" ? codexAgent(brokered, codexPath) : claude.run(brokered)
  } })
}

/**
 * Where the SDK keeps the conversation of an agent that ran in `cwd` (Retry and take-over resume from
 * it), under the CLI's `configDir`: its real path (`/tmp` is `/private/tmp`) with every character but
 * letters and digits as `-`.
 */
export const claudeProjectDir = (configDir: string, cwd: string): string => {
  const real = (() => {
    try {
      return join(realpathSync(dirname(cwd)), basename(cwd))
    } catch {
      return cwd
    }
  })()
  return join(configDir, "projects", real.replace(/[^A-Za-z0-9]/g, "-"))
}

/** How long an abandoned query gets to wind down after its abort before the turn moves on regardless. */
const RETURN_GRACE_MS = 5_000

/**
 * Abandoning the iteration (an interrupted turn: stop, shutdown) aborts the
 * query first. An async generator's `return()` waits for the pending `next()`,
 * which only settles once the CLI is told to stop, so the order matters.
 */
export const abortOnReturn = <A>(iterable: AsyncIterable<A>, abort: AbortController): AsyncIterable<A> => ({
  [Symbol.asyncIterator]: () => {
    const iterator = iterable[Symbol.asyncIterator]()
    return {
      next: () => iterator.next(),
      return: async (): Promise<IteratorResult<A>> => {
        abort.abort()
        if (iterator.return !== undefined) await Promise.race([iterator.return().catch(() => undefined), Bun.sleep(RETURN_GRACE_MS)])
        return { done: true, value: undefined }
      },
    }
  },
})
