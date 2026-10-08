import { query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Context, Layer } from "effect"
import { claudeExecutable } from "../agent/agent.ts"

/** Memory jobs use a separate Claude capability set from provider-specific investigation sessions. */
export interface MemoryModelShape {
  readonly query: (params: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options }) => AsyncIterable<SDKMessage>
}
export class MemoryModel extends Context.Service<MemoryModel, MemoryModelShape>()("MemoryModel") {}

export const MemoryModelLive = (claudePath: string | undefined) => Layer.succeed(MemoryModel)({
  query: ({ prompt, options }) => {
    const executable = claudeExecutable(claudePath)
    return query({ prompt, options: executable === undefined ? options : { ...options, pathToClaudeCodeExecutable: executable } })
  },
})
