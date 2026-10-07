import { Schema } from "effect"
import { writeRefusal } from "./confine.ts"
import { type ToolGuard, toolRefusal } from "./hook.ts"

const HookInput = Schema.Struct({ tool_name: Schema.String, tool_input: Schema.Unknown, cwd: Schema.String })
const Command = Schema.Union([Schema.Struct({ command: Schema.String }), Schema.Struct({ cmd: Schema.String })])

/** All patch destinations, including moves, are checked before any patch is applied. */
export const patchPaths = (patch: string): ReadonlyArray<string> | undefined => {
  const lines = patch.replaceAll("\r\n", "\n").split("\n")
  if (lines[0] !== "*** Begin Patch" || lines.at(-1)?.trim() !== "*** End Patch") return undefined
  const paths: Array<string> = []
  for (const line of lines) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line)
    if (match?.[1] !== undefined) paths.push(match[1])
  }
  return paths.length === 0 ? undefined : paths
}

const SAFE_LOCAL_TOOLS = new Set(["update_plan", "read_file", "list_dir", "grep_files", "view_image"])

/** Codex's tool names are normalized into the existing command and write policies. Unknown tools fail closed. */
export const codexToolRefusal = (guard: ToolGuard, name: string, input: unknown): string | undefined => {
  if (name === "Bash" || name === "exec_command" || name === "shell" || name === "shell_command") {
    const command = Schema.decodeUnknownOption(Command)(input)
    if (command._tag === "None") return "Bridgetown could not read this command."
    return toolRefusal(guard, "Bash", { command: "command" in command.value ? command.value.command : command.value.cmd })
  }
  if (name === "apply_patch") {
    const command = Schema.decodeUnknownOption(Command)(input)
    const patch = typeof input === "string" ? input : command._tag === "Some" ? ("command" in command.value ? command.value.command : command.value.cmd) : undefined
    const paths = patch === undefined ? undefined : patchPaths(patch.trimEnd())
    if (paths === undefined) return "Bridgetown could not check this patch."
    for (const path of paths) {
      const reason = writeRefusal("Write", { file_path: path }, guard.worktree)
      if (reason !== undefined) return reason
    }
    return undefined
  }
  if (SAFE_LOCAL_TOOLS.has(name) || /^mcp__(merkl|grafana|bridgetown)__/.test(name)) return undefined
  if (["report", "ask", "slack_context"].includes(name)) return undefined
  return `Bridgetown does not allow the ${name} tool in investigation sessions.`
}

export const codexHookVerdict = (raw: unknown, guard: ToolGuard) => {
  try {
    const input = Schema.decodeUnknownSync(HookInput)(raw)
    const reason = codexToolRefusal({ ...guard, cwd: input.cwd }, input.tool_name, input.tool_input)
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: reason === undefined ? "allow" : "deny", ...(reason === undefined ? {} : { permissionDecisionReason: reason }) } }
  } catch {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Bridgetown could not check this tool call." } }
  }
}
