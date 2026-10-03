import { randomUUID } from "node:crypto"
import type { McpServerConfig, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { AgentShape } from "../../src/sessions/agent.ts"
import type { SessionResult } from "../../src/sessions/output.ts"
import { TOOL_SERVER } from "../../src/sessions/tools.ts"
import * as Sdk from "./sdk.ts"

/**
 * A scripted stand-in for the Claude CLI. The real runner drives it exactly as
 * it drives the CLI: one query per turn, your messages arrive on its streaming
 * input, `report` and `ask` go through Bridgetown's real in-process MCP tools
 * (so an ask puts up a real answer card and blocks until you reply), and its
 * `result` is finalized by the real `decideOutcome`.
 */

export type Step =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly kind: "report"; readonly phase: "diagnose" | "fix" | "pr" | "ci"; readonly note: string }
  | { readonly kind: "ask"; readonly question: string; readonly options: ReadonlyArray<string> }
  | { readonly kind: "result"; readonly output: SessionResult; readonly costUsd: number }

export interface Script {
  /** Played once, in order. */
  readonly steps: ReadonlyArray<Step>
  /** Then played over and over until the turn is stopped; omit to end after `steps` (a script that ends should end with a result). */
  readonly loop?: ReadonlyArray<Step>
  /** Milliseconds between steps. */
  readonly paceMs: number
}

export interface Turn {
  readonly sessionId: string
  /** A resumed conversation (a retry, your message to a handed-back session). */
  readonly resume: boolean
  /** The turn's first prompt. */
  readonly prompt: string
}

const textOf = (message: SDKUserMessage): string => {
  const content = message.message.content
  if (typeof content === "string") return content
  return content.map((block) => (block.type === "text" ? block.text : "")).join("")
}

/** Resolves after `ms`, or as soon as the turn is aborted. */
const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })

/** The streaming input, read in the background: the first message is the prompt, the rest are your messages. */
const readInput = (prompt: AsyncIterable<SDKUserMessage>) => {
  const pending: Array<string> = []
  let first: (text: string) => void = () => {}
  const prompted = new Promise<string>((resolve) => (first = resolve))
  void (async () => {
    let seen = 0
    for await (const message of prompt) {
      if (seen++ === 0) first(textOf(message))
      else pending.push(textOf(message))
    }
    first("")
  })()
  return { prompted, pending }
}

/** Bridgetown's tool server as the CLI would reach it: an MCP client over an in-memory transport. */
const toolClient = (servers: Options["mcpServers"]) => {
  let client: Promise<Client> | undefined
  const connect = async (config: McpServerConfig | undefined) => {
    if (config?.type !== "sdk" || !("instance" in config)) throw new Error("no Bridgetown tool server in the query options")
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await config.instance.connect(serverSide)
    const connected = new Client({ name: "bridgetown-mock-agent", version: "0" })
    await connected.connect(clientSide)
    return connected
  }
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    client ??= connect(servers?.[TOOL_SERVER])
    // An ask waits for you for up to 30 minutes; MCP's own request timeout is a minute.
    const reply = await (await client).callTool({ name, arguments: args }, undefined, { timeout: 31 * 60_000 })
    const content = Array.isArray(reply.content) ? reply.content : []
    return content.map((block: unknown) => (typeof block === "object" && block !== null && "text" in block ? String(block.text) : "")).join("")
  }
}

/** What the agent says when one of your messages reaches it mid-turn. */
const acknowledge = (text: string) => `Got your message — "${text}". Taking that into account.`

export const scriptedAgent = (scriptFor: (turn: Turn) => Script): AgentShape => ({
  query: ({ prompt, options }) => {
    const sessionId = options.env?.BRIDGETOWN_SESSION ?? "unknown"
    const conversation = options.resume ?? randomUUID()
    const signal = options.abortController?.signal
    const aborted = () => signal?.aborted === true
    const input = readInput(prompt)
    const callTool = toolClient(options.mcpServers)

    async function* run(): AsyncGenerator<SDKMessage> {
      const first = await input.prompted
      yield Sdk.init(conversation, options.cwd ?? "")
      const script = scriptFor({ sessionId, resume: options.resume !== undefined, prompt: first })
      const say = (text: string) => Sdk.assistant(conversation, { type: "text", text })
      for (let index = 0; ; index++) {
        const loop = script.loop ?? []
        const step = index < script.steps.length ? script.steps[index] : loop[(index - script.steps.length) % Math.max(loop.length, 1)]
        if (step === undefined) return
        await sleep(script.paceMs, signal)
        if (aborted()) return
        for (const message of input.pending.splice(0)) yield say(acknowledge(message))
        switch (step.kind) {
          case "text":
            yield say(step.text)
            break
          case "tool":
            yield Sdk.assistant(conversation, { type: "tool_use", name: step.name, input: step.input })
            break
          case "report":
            yield Sdk.assistant(conversation, { type: "tool_use", name: `mcp__${TOOL_SERVER}__report`, input: { phase: step.phase, note: step.note } })
            await callTool("report", { phase: step.phase, note: step.note })
            break
          case "ask": {
            const args = { question: step.question, options: [...step.options] }
            yield Sdk.assistant(conversation, { type: "tool_use", name: `mcp__${TOOL_SERVER}__ask`, input: args })
            const answer = await Promise.race([callTool("ask", args), sleep(31 * 60_000, signal).then(() => undefined)])
            if (answer === undefined || aborted()) return
            const said = /The user answered: (.*)/s.exec(answer)?.[1]
            yield say(said === undefined ? "No answer, so I'll go with my best judgement." : `Thanks — going with "${said}".`)
            break
          }
          case "result":
            yield Sdk.result(conversation, step.output, step.costUsd)
            return
        }
      }
    }
    return run()
  },
})
