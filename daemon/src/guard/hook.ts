import type { HookCallback } from "@anthropic-ai/claude-agent-sdk"
import { commandOf, type GuardContext, hostRefusal, refusal } from "./bash.ts"
import { pathOf, WRITE_TOOLS, writeRefusal } from "./confine.ts"

/** Everything one tool call is checked against: the shell-command policy context plus the write boundary. */
export interface ToolGuard extends GuardContext {
  /** The session's worktree, or `null` before it is ready. Writes must land inside it. */
  readonly worktree: string | null
}

const urlOf = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null || !("url" in input)) return undefined
  return typeof input.url === "string" ? input.url : undefined
}

/** The part of a tool call worth logging when it is refused. */
const describe = (toolName: string, input: unknown): string => commandOf(input) ?? pathOf(input) ?? urlOf(input) ?? toolName

/**
 * The one gate every tool call passes through, from both the PreToolUse hook and
 * `canUseTool`. A tool that runs a command (Bash, or any future tool carrying a
 * `command`) goes through the shell policy; a write tool through the worktree
 * boundary; WebFetch's URL through the same host rules as a network command;
 * anything else is allowed. It fails closed: any exception refuses the call, so
 * a parser bug or a malformed input can never open a hole.
 */
export const toolRefusal = (guard: ToolGuard, toolName: string, input: unknown): string | undefined => {
  try {
    const command = commandOf(input)
    if (command !== undefined) return refusal(command, guard)
    if (WRITE_TOOLS.includes(toolName)) return writeRefusal(toolName, input, guard.worktree)
    if (toolName === "WebFetch") {
      const url = urlOf(input)
      return url === undefined ? undefined : hostRefusal(url, guard.daemonPort)
    }
    return undefined
  } catch {
    return `Bridgetown could not check this ${toolName} call, so it refused it. Run a simpler command or describe it in your result instead.`
  }
}

/** The matcher-less PreToolUse hook: the real gate, run before allow rules and permission modes, for every tool. */
export const toolGuard = (guard: ToolGuard, onRefused: (what: string, reason: string) => void): HookCallback =>
  async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {}
    const reason = toolRefusal(guard, input.tool_name, input.tool_input)
    if (reason === undefined) return {}
    onRefused(describe(input.tool_name, input.tool_input), reason)
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }
  }
