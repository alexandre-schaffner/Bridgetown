import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { type Options, query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Context, Layer } from "effect"

/** The Claude Agent SDK's `query`, as a service so tests can run turns without a CLI. */
export interface AgentShape {
  readonly query: (params: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options }) => AsyncIterable<SDKMessage>
}

export class Agent extends Context.Service<Agent, AgentShape>()("Agent") {}

export const AgentLive = Layer.succeed(Agent)({ query: ({ prompt, options }) => query({ prompt, options }) })

/**
 * Where the SDK keeps the conversation of an agent that ran in `cwd` (Retry and take-over resume from
 * it): its real path (`/tmp` is `/private/tmp`) with every character but letters and digits as `-`.
 */
export const claudeProjectDir = (cwd: string): string => {
  const real = (() => {
    try {
      return join(realpathSync(dirname(cwd)), basename(cwd))
    } catch {
      return cwd
    }
  })()
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", real.replace(/[^A-Za-z0-9]/g, "-"))
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
