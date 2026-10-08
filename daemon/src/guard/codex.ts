import { Schema } from "effect"
import { investigationToolRefusal } from "../security/capabilities.ts"

const HookInput = Schema.Struct({ tool_name: Schema.String, tool_input: Schema.Unknown, cwd: Schema.String })

/** Built-in execution and file access never bypass the typed broker. Unknown calls fail closed. */
export const codexHookVerdict = (raw: unknown) => {
  const input = Schema.decodeUnknownOption(HookInput)(raw)
  const reason = input._tag === "None" ? "Bridgetown could not check this tool call." : investigationToolRefusal(input.value.tool_name)
  return { hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: reason === undefined ? "allow" : "deny",
    ...(reason === undefined ? {} : { permissionDecisionReason: reason }),
  } }
}
