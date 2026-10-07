import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import { claudeAgent, type AgentShape } from "../../src/agent/agent.ts"
import type { SessionResult } from "../../src/agent/result.ts"
import * as Sdk from "./sdk.ts"
import { eventually } from "./wait.ts"

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

export const RESULT: SessionResult = {
  outcome: "needs_human", rootCauseFound: true, diagnosis: "d", tried: [], summary: "s", prUrl: null,
  recommendation: null, recommendationDetail: null, releasePrefix: null,
}

/**
 * An agent whose every turn plays `plays` once and then lets the CLI exit; `turns` counts the queries, `aborted` those
 * Bridgetown aborted. Aborting the query ends it, as it kills the CLI.
 */
export const playingAgent = (plays: ReadonlyArray<Play>) => {
  const state = { turns: 0, aborted: 0 }
  const agent: AgentShape = claudeAgent(({ options }) => {
      state.turns += 1
      const aborted = new Promise<"aborted">((resolve) =>
        options.abortController?.signal.addEventListener("abort", () => {
          state.aborted += 1
          resolve("aborted")
        }),
      )
      async function* run(): AsyncGenerator<SDKMessage> {
        const call = await Sdk.connectTools(options, "bridgetown-test-agent")
        for (const play of plays) {
          switch (play.kind) {
            case "tool":
              if ((await Promise.race([call(play.name, play.args), aborted])) === "aborted") return
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
    })
  return { agent, state }
}

/**
 * An agent that reads its streaming input and never finishes on its own: it records every message it is sent, and
 * ends only when its query is aborted. `received(...texts)` waits until those texts (any one, when none is named) arrived.
 */
export const recordingAgent = () => {
  const seen: Array<SDKUserMessage> = []
  const state = { queries: 0, aborted: 0 }
  const agent: AgentShape = claudeAgent(({ prompt, options }) => {
      state.queries += 1
      const ended = new Promise<IteratorResult<SDKMessage>>((resolve) =>
        options.abortController?.signal.addEventListener("abort", () => {
          state.aborted += 1
          resolve({ done: true, value: undefined })
        }),
      )
      void (async () => {
        for await (const message of prompt) seen.push(message)
      })()
      return { [Symbol.asyncIterator]: () => ({ next: () => ended }) }
    })
  const texts = () => seen.map((m) => (typeof m.message.content === "string" ? m.message.content : ""))
  const received = (...wanted: ReadonlyArray<string>) =>
    Effect.runPromise(eventually(Effect.sync(texts), (all) => ((wanted.length === 0 ? all.length > 0 : wanted.every((text) => all.includes(text))) ? all : undefined)))
  return { agent, seen, state, texts, received }
}
