import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import * as Sdk from "../../scripts/mock/sdk.ts"
import type { AgentShape } from "../../src/sessions/agent.ts"
import type { SessionResult } from "../../src/sessions/output.ts"
import { TOOL_SERVER } from "../../src/sessions/tools.ts"

/** One thing a turn of the playing agent does, in order. */
export type Play =
  /** Calls one of Bridgetown's tools and waits for its answer. */
  | { readonly kind: "tool"; readonly name: string; readonly args: Record<string, unknown> }
  /** Calls a tool and moves on without waiting (the CLI dying mid-call). */
  | { readonly kind: "fire"; readonly name: string; readonly args: Record<string, unknown> }
  | { readonly kind: "message"; readonly message: SDKMessage }
  | { readonly kind: "result"; readonly output: SessionResult }
  /** The CLI fails. */
  | { readonly kind: "crash"; readonly reason: string }

/** Bridgetown's in-process tool server, reached the way the CLI reaches it: an MCP client. */
const toolsOf = async (options: Options) => {
  const server = options.mcpServers?.[TOOL_SERVER]
  if (server?.type !== "sdk" || !("instance" in server)) throw new Error("no Bridgetown tool server in the query options")
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.instance.connect(serverSide)
  const client = new Client({ name: "bridgetown-test-agent", version: "0" })
  await client.connect(clientSide)
  return (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })
}

export const RESULT: SessionResult = {
  outcome: "needs_human", rootCauseFound: true, diagnosis: "d", tried: [], summary: "s", prUrl: null,
  recommendation: null, recommendationDetail: null, releasePrefix: null,
}

/** An agent whose every turn plays `plays` once and then lets the CLI exit; `turns` counts the queries. */
export const playingAgent = (plays: ReadonlyArray<Play>) => {
  const state = { turns: 0 }
  const agent: AgentShape = {
    query: ({ options }) => {
      state.turns += 1
      async function* run(): AsyncGenerator<SDKMessage> {
        const call = await toolsOf(options)
        for (const play of plays) {
          switch (play.kind) {
            case "tool":
              await call(play.name, play.args)
              break
            case "fire":
              void call(play.name, play.args).catch(() => undefined)
              // Long enough for the call to reach Bridgetown and put up its card.
              await Bun.sleep(50)
              break
            case "message":
              yield play.message
              break
            case "result":
              yield Sdk.result("conversation", play.output, 0)
              break
            case "crash":
              throw new Error(play.reason)
          }
        }
      }
      return run()
    },
  }
  return { agent, state }
}

export const init = Sdk.init
