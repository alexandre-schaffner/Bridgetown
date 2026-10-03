import { randomUUID } from "node:crypto"
import type { NonNullableUsage, SDKAssistantMessage, SDKResultSuccess, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk"
import type { SessionResult } from "../../src/sessions/output.ts"

/**
 * The Agent SDK messages a real CLI streams, built by hand for the mock's
 * scripted agent. Only `system/init`, `assistant` and `result` matter to the
 * daemon (`sessions/sdk-events.ts`); the bookkeeping fields are zeros.
 */

const MODEL = "claude-opus-5-5"

const usage: NonNullableUsage = {
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  fallback_credit: { status: { type: "not_applied", reason: "not_enabled" } },
  inference_geo: "",
  input_tokens: 0,
  iterations: [],
  output_tokens: 0,
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: "standard",
  speed: "standard",
}

export const init = (sessionId: string, cwd: string): SDKSystemMessage => ({
  type: "system",
  subtype: "init",
  apiKeySource: "user",
  claude_code_version: "mock",
  cwd,
  tools: ["Bash", "Read", "Edit", "Grep"],
  mcp_servers: [
    { name: "merkl", status: "connected" },
    { name: "grafana", status: "connected" },
  ],
  model: MODEL,
  permissionMode: "acceptEdits",
  slash_commands: [],
  output_style: "default",
  skills: [],
  plugins: [],
  uuid: randomUUID(),
  session_id: sessionId,
})

type Block = { readonly type: "text"; readonly text: string } | { readonly type: "tool_use"; readonly name: string; readonly input: Record<string, unknown> }

export const assistant = (sessionId: string, block: Block): SDKAssistantMessage => ({
  type: "assistant",
  parent_tool_use_id: null,
  uuid: randomUUID(),
  session_id: sessionId,
  message: {
    id: `msg_${randomUUID()}`,
    container: null,
    content: [
      block.type === "text"
        ? { type: "text", text: block.text, citations: null }
        : { type: "tool_use", id: `toolu_${randomUUID()}`, name: block.name, input: block.input },
    ],
    context_management: null,
    diagnostics: null,
    model: MODEL,
    role: "assistant",
    stop_details: null,
    stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn",
    stop_sequence: null,
    type: "message",
    usage: { ...usage, fallback_credit: null, iterations: null },
  },
})

export const result = (sessionId: string, output: SessionResult, costUsd: number): SDKResultSuccess => ({
  type: "result",
  subtype: "success",
  duration_ms: 0,
  duration_api_ms: 0,
  is_error: false,
  num_turns: 1,
  result: output.summary,
  stop_reason: "end_turn",
  total_cost_usd: costUsd,
  usage,
  modelUsage: {},
  permission_denials: [],
  structured_output: output,
  uuid: randomUUID(),
  session_id: sessionId,
})
