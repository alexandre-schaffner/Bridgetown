import type { TurnSetup } from "./options.ts"

/** Provider adapters emit facts; the session runner owns persistence and transitions. */
export type AgentEvent =
  | { readonly kind: "init"; readonly conversationId: string; readonly configDir?: string; readonly servers: ReadonlyArray<{ readonly name: string; readonly status: string }> }
  | { readonly kind: "mcp"; readonly servers: ReadonlyArray<{ readonly name: string; readonly status: string }> }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly input: unknown }
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "result"; readonly text: string; readonly output: unknown; readonly costUsd: number | null; readonly error: string | null }

/** Preserve the user's permission to reopen when delivery races a turn's completion. */
export interface AgentInput {
  readonly text: string
  readonly reopen: boolean
}

export interface AgentRequest extends TurnSetup {
  readonly prompt: AsyncIterable<AgentInput>
  readonly onUndelivered: (input: AgentInput) => Promise<void>
}
