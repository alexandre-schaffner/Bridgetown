import { existsSync, readFileSync, rmSync } from "node:fs"
import { basename, join } from "node:path"
import { Effect } from "effect"
import { appSupportDir } from "../config.ts"
import { AdapterError } from "../domain/errors.ts"
import { run, runOk } from "../proc.ts"

const INSTALL_TIMEOUT_MS = 10 * 60_000

export const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")

/** The monorepo keeps agent worktrees under `.shared/worktrees/`; other repos get one in app support. */
export const worktreePath = (repoPath: string, branch: string): string =>
  existsSync(join(repoPath, ".shared"))
    ? join(repoPath, ".shared", "worktrees", branch)
    : join(appSupportDir(), "worktrees", basename(repoPath), branch)

export interface Worktree {
  readonly path: string
  /** Setup problems that did not stop the session; the agent and the user both see them. */
  readonly warnings: ReadonlyArray<string>
}

const FETCH_ATTEMPTS = 3

const tail = (text: string, lines = 6): string => text.trim().split("\n").slice(-lines).join("\n")

/** `"packageManager": "bun@1.4.2"` → `"1.4.2"`. */
export const pinnedBunVersion = (repoPath: string): string | undefined => {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"))
    if (typeof manifest !== "object" || manifest === null || !("packageManager" in manifest)) return undefined
    const pin = manifest.packageManager
    return typeof pin === "string" ? /^bun@(\d+\.\d+\.\d+)/.exec(pin)?.[1] : undefined
  } catch {
    return undefined
  }
}

/** Fetch with backoff; a stale local origin/main is better than no session. */
const fetchMain = Effect.fn("fetchMain")(function* (repoPath: string) {
  let lastError = ""
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    const result = yield* run(["git", "fetch", "origin", "main"], { cwd: repoPath, timeoutMs: 120_000 })
    if (result.exitCode === 0) return undefined
    lastError = tail(result.stderr, 3)
    if (attempt < FETCH_ATTEMPTS) yield* Effect.sleep(`${2 ** attempt} seconds`)
  }
  const local = yield* run(["git", "rev-parse", "--verify", "--quiet", "origin/main"], { cwd: repoPath })
  if (local.exitCode !== 0) return yield* new AdapterError({ adapter: "git", operation: "fetch", message: lastError, cause: null })
  return `git fetch failed ${FETCH_ATTEMPTS} times, so the worktree starts from the last fetched origin/main, which may be stale:\n${lastError}`
})

/**
 * Dependencies are best effort: a broken install (an outdated bun that cannot read
 * a newer lockfile, a flaky registry) becomes a warning, and the agent, which may
 * be there to fix exactly that, still starts.
 */
const install = Effect.fn("install")(function* (path: string, repoPath: string) {
  if (!existsSync(join(path, "package.json")) || existsSync(join(path, "node_modules"))) return []
  const warnings: Array<string> = []
  const pinned = pinnedBunVersion(repoPath)
  const local = (yield* run(["bun", "--version"]).pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })))).stdout.trim()
  if (pinned !== undefined && local !== "" && pinned !== local) {
    warnings.push(`The repo pins bun ${pinned} but this machine has bun ${local}. Run \`bun upgrade\` if installs or builds misbehave.`)
  }
  const result = yield* run(["bun", "install"], { cwd: path, timeoutMs: INSTALL_TIMEOUT_MS })
  if (result.exitCode !== 0) warnings.push(`\`bun install\` failed (exit ${result.exitCode}); dependencies are missing:\n${tail(result.stderr || result.stdout)}`)
  return warnings
})

export const createWorktree = Effect.fn("createWorktree")(function* (repoPath: string, branch: string) {
  const path = worktreePath(repoPath, branch)
  const warnings: Array<string> = []
  if (!existsSync(join(path, ".git"))) {
    const fetchWarning = yield* fetchMain(repoPath)
    if (fetchWarning !== undefined) warnings.push(fetchWarning)
    yield* run(["git", "worktree", "prune"], { cwd: repoPath })
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
    const existing = yield* run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath })
    yield* runOk(
      existing.exitCode === 0
        ? ["git", "worktree", "add", path, branch]
        : ["git", "worktree", "add", "-b", branch, path, "origin/main"],
      { cwd: repoPath },
    )
  }
  warnings.push(...(yield* install(path, repoPath)))
  const worktree: Worktree = { path, warnings }
  return worktree
})

export const removeWorktree = (repoPath: string, path: string) =>
  run(["git", "worktree", "remove", "--force", path], { cwd: repoPath }).pipe(Effect.asVoid)
