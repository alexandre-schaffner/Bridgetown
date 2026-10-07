import { readlinkSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"

/** File tools that write. Reads (Read, Grep, Glob) stay open: the agent may need the main checkout or the deployment repo. */
export const WRITE_TOOLS: ReadonlyArray<string> = ["Edit", "Write", "MultiEdit", "NotebookEdit"]

/** The destination path of a write tool call, from `file_path` or a notebook's `notebook_path`. */
export const pathOf = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined
  const value = "file_path" in input ? input.file_path : "notebook_path" in input ? input.notebook_path : undefined
  return typeof value === "string" ? value : undefined
}

/** How the CLI reads a `file_path`: trimmed, `~`/`~/` expanded, then resolved against the worktree. A relative path resolves there because the CLI's cwd is the worktree and is reset to it after every Bash call. */
const normalise = (path: string, worktree: string): string | undefined => {
  if (path.includes("\0")) return undefined
  const trimmed = path.trim()
  if (trimmed === "") return undefined
  if (trimmed === "~") return homedir()
  const expanded = trimmed.startsWith("~/") ? resolve(homedir(), trimmed.slice(2)) : trimmed
  return isAbsolute(expanded) ? expanded : resolve(worktree, expanded)
}

/**
 * Resolves a path through symlinks to where a write would actually land, even
 * when the file does not exist yet: it walks the ancestors, following any
 * symlink to its target (dangling ones included, so a link to a not-yet-created
 * file outside is judged by that target). A short hop limit stops symlink loops.
 */
const landing = (path: string): string => {
  let current = resolve(path)
  for (let hops = 0; hops < 40; hops++) {
    try {
      const link = readlinkSync(current)
      current = resolve(dirname(current), link)
      continue
    } catch {
      // Not a symlink (or unreadable): the component itself is final; resolve its parent.
    }
    const parent = dirname(current)
    if (parent === current) return current
    return resolve(resolveAncestor(parent), basename(current))
  }
  return current
}

/** The real path of an existing directory, falling back to the lexical path so a missing ancestor is still judged where it would be created. */
const resolveAncestor = (dir: string): string => {
  try {
    return realpathSync(dir)
  } catch {
    const parent = dirname(dir)
    if (parent === dir) return dir
    return resolve(resolveAncestor(parent), basename(dir))
  }
}

/** Why this file write is refused, or `undefined` when it lands inside the session's worktree. */
export const writeRefusal = (toolName: string, input: unknown, worktree: string | null): string | undefined => {
  if (!WRITE_TOOLS.includes(toolName)) return undefined
  if (worktree === null) return "The worktree is not ready yet; nothing can be written."
  const outside = `Write only inside your worktree (${worktree}). Describe changes elsewhere in your final output instead.`
  const path = pathOf(input)
  if (path === undefined) return outside
  // `..` is refused outright, even when it would land inside: it is never needed and widens what a symlink could reach.
  if (path.split(/[\\/]/).includes("..")) return outside
  const resolved = normalise(path, worktree)
  if (resolved === undefined) return outside
  const root = landing(worktree)
  const target = landing(resolved)
  const rel = relative(root, target)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? undefined : outside
}
