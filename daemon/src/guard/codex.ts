import { Schema } from "effect"
import { inheritedToolRefusal, investigationToolRefusal } from "../security/capabilities.ts"

const HookInput = Schema.Struct({ tool_name: Schema.String, tool_input: Schema.Unknown, cwd: Schema.String })

/**
 * Built-in execution and file access never bypass the typed broker. Unknown calls fail closed. `inherit` admits the user's own MCP tools.
 * Codex rejects `permissionDecision: "allow"` as unsupported, so a permitted call gets no decision at all.
 */
export const codexHookVerdict = (raw: unknown, inherit = false): { readonly hookSpecificOutput?: { readonly hookEventName: "PreToolUse"; readonly permissionDecision: "deny"; readonly permissionDecisionReason: string } } => {
  const input = Schema.decodeUnknownOption(HookInput)(raw)
  const reason = input._tag === "None" ? "Bridgetown could not check this tool call." : (inherit ? inheritedToolRefusal : investigationToolRefusal)(input.value.tool_name)
  return reason === undefined ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
}
