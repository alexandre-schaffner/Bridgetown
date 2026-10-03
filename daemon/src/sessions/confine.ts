import { realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk"

/** File tools that write. Reads (Read, Grep, Glob) stay open: the agent may need the main checkout or the deployment repo. */
export const WRITE_TOOLS: ReadonlyArray<string> = ["Edit", "Write", "MultiEdit", "NotebookEdit"]

const pathOf = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined
  const value = "file_path" in input ? input.file_path : "notebook_path" in input ? input.notebook_path : undefined
  return typeof value === "string" ? value : undefined
}

/** Resolves symlinks through the deepest existing ancestor, so a file that does not exist yet is judged by where it would land. */
const landing = (path: string): string => {
  const missing: Array<string> = []
  let current = path
  while (true) {
    try {
      return join(realpathSync(current), ...missing.toReversed())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

/** Why this file write is refused, or `undefined` when it lands inside the session's worktree. */
export const writeRefusal = (toolName: string, input: unknown, worktree: string | null): string | undefined => {
  if (!WRITE_TOOLS.includes(toolName)) return undefined
  if (worktree === null) return "The worktree is not ready yet; nothing can be written."
  const outside = `Write only inside your worktree (${worktree}). Describe changes elsewhere in your final output instead.`
  const path = pathOf(input)
  if (path === undefined) return outside
  if (path.split(/[\\/]/).includes("..")) return outside
  const root = landing(worktree)
  const target = landing(isAbsolute(path) ? path : resolve(worktree, path))
  const rel = relative(root, target)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? undefined : outside
}

export const writeGuard = (worktree: string | null, onDeny: (path: string, reason: string) => void): HookCallback =>
  async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {}
    const reason = writeRefusal(input.tool_name, input.tool_input, worktree)
    if (reason === undefined) return {}
    onDeny(pathOf(input.tool_input) ?? input.tool_name, reason)
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }
  }
