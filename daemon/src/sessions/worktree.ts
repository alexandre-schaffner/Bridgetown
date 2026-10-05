import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { basename, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { appSupportDir } from "../config.ts"
import { AdapterError, attempt } from "../domain/errors.ts"
import { run, runOk } from "../proc.ts"
import { makeKeyedLock } from "../store/keyed-lock.ts"

const INSTALL_TIMEOUT_MS = 10 * 60_000
/** A session worktree is a monorepo checkout plus its node_modules: hundreds of thousands of files to delete. */
const REMOVE_TIMEOUT_MS = 10 * 60_000

export const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")

/**
 * `fix-bt-<slug>-<id tail>` (`branchFor`): the only branches Bridgetown makes, so the only worktrees and
 * branches it ever removes. One path segment, never `..`: the mock's ids put an `_` in the tail.
 */
const SESSION_BRANCH = /^fix-bt-[a-z0-9_-]+$/

export const isSessionBranch = (branch: string | null): branch is string => branch !== null && SESSION_BRANCH.test(branch)

/** The monorepo keeps agent worktrees under `.shared/worktrees/`; other repos get one in app support. */
export const worktreePath = (repoPath: string, branch: string): string =>
  existsSync(join(repoPath, ".shared"))
    ? join(repoPath, ".shared", "worktrees", branch)
    : join(appSupportDir(), "worktrees", basename(repoPath), branch)

export interface Worktree {
  readonly path: string
  /** Setup problems that did not stop the session; the agent and the user both see them. */
  readonly warnings: ReadonlyArray<string>
  /** The repo pins another bun than this machine has: one of the warnings, and the menu bar's too, since every session hits it. */
  readonly bunMismatch: string | null
}

export interface WorktreesShape {
  /**
   * The session's worktree, ready for the agent: its branch checked out (a new one from
   * `origin/<branch>` when only the pushed branch is left, else from `origin/main`), and
   * dependencies installed. Picks up a checkout or install that was cut short.
   */
  readonly create: (repoPath: string, branch: string) => Effect.Effect<Worktree, AdapterError>
  /** Deletes the worktree, and with `deleteBranch` its branch and follow-ups (`<branch>-2`). Idempotent. */
  readonly remove: (repoPath: string, branch: string, options: { readonly deleteBranch: boolean }) => Effect.Effect<void, AdapterError>
}

/** Session worktrees: the only code that makes or deletes them, one at a time per path, so a Retry never races a removal. */
export class Worktrees extends Context.Service<Worktrees, WorktreesShape>()("Worktrees") {}

const FETCH_ATTEMPTS = 3

/** Written once `bun install` succeeded: a `node_modules` without it is an install that was cut short. */
const INSTALLED_MARKER = ".bridgetown-installed"

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
 * The branch when it exists. Without it, a new one from what the agent pushed (Retry
 * after the local branch went: pushed from a worktree of this clone, its remote-tracking
 * ref is here without a fetch), or from origin/main for a new session.
 */
const addCommand = Effect.fn("addCommand")(function* (repoPath: string, branch: string, path: string) {
  const has = (ref: string) => run(["git", "rev-parse", "--verify", "--quiet", ref], { cwd: repoPath }).pipe(Effect.map((r) => r.exitCode === 0))
  if (yield* has(`refs/heads/${branch}`)) return ["git", "worktree", "add", path, branch]
  const base = (yield* has(`refs/remotes/origin/${branch}`)) ? `origin/${branch}` : "origin/main"
  return ["git", "worktree", "add", "-b", branch, path, base]
})

/**
 * Dependencies are best effort: a broken install (an outdated bun that cannot read
 * a newer lockfile, a flaky registry) becomes a warning, and the agent, which may
 * be there to fix exactly that, still starts.
 */
const install = Effect.fn("install")(function* (path: string, repoPath: string) {
  const modules = join(path, "node_modules")
  if (!existsSync(join(path, "package.json")) || existsSync(join(modules, INSTALLED_MARKER))) return { warnings: [], bunMismatch: null }
  const warnings: Array<string> = []
  const pinned = pinnedBunVersion(repoPath)
  const local = (yield* run(["bun", "--version"]).pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })))).stdout.trim()
  const bunMismatch =
    pinned !== undefined && local !== "" && pinned !== local
      ? `The repo pins bun ${pinned} but this machine has bun ${local}. Run \`bun upgrade\` if installs or builds misbehave.`
      : null
  if (bunMismatch !== null) warnings.push(bunMismatch)
  const result = yield* run(["bun", "install"], { cwd: path, timeoutMs: INSTALL_TIMEOUT_MS })
  if (result.exitCode === 0) {
    mkdirSync(modules, { recursive: true })
    writeFileSync(join(modules, INSTALLED_MARKER), "")
  } else {
    warnings.push(`\`bun install\` failed (exit ${result.exitCode}); dependencies are missing:\n${tail(result.stderr || result.stdout)}`)
  }
  return { warnings, bunMismatch }
})

const create = Effect.fn("Worktrees.create")(function* (repoPath: string, branch: string) {
  const path = worktreePath(repoPath, branch)
  const warnings: Array<string> = []
  if (!existsSync(join(path, ".git"))) {
    const fetchWarning = yield* fetchMain(repoPath)
    if (fetchWarning !== undefined) warnings.push(fetchWarning)
    yield* run(["git", "worktree", "prune"], { cwd: repoPath })
    // A checkout cut short: the session's own directory, so it goes.
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
    yield* runOk(yield* addCommand(repoPath, branch, path), { cwd: repoPath })
  }
  const installed = yield* install(path, repoPath)
  const worktree: Worktree = { path, warnings: [...warnings, ...installed.warnings], bunMismatch: installed.bunMismatch }
  return worktree
})

const remove = Effect.fn("Worktrees.remove")(function* (repoPath: string, branch: string, options: { readonly deleteBranch: boolean }) {
  // No repo, no worktree or branch of it.
  if (!existsSync(repoPath)) return
  const path = worktreePath(repoPath, branch)
  if (existsSync(path)) {
    // Forced twice: a worktree with changes or a lock goes too. A directory git no longer knows is deleted
    // outright, off the event loop, since it may be as big.
    yield* run(["git", "worktree", "remove", "--force", "--force", path], { cwd: repoPath, timeoutMs: REMOVE_TIMEOUT_MS })
    if (existsSync(path)) yield* attempt("fs", "remove worktree", () => rm(path, { recursive: true, force: true }))
  }
  yield* run(["git", "worktree", "prune"], { cwd: repoPath })
  if (!options.deleteBranch) return
  const refs = yield* runOk(["git", "for-each-ref", "--format=%(refname:short)", `refs/heads/${branch}`, `refs/heads/${branch}-*`], { cwd: repoPath })
  const followUp = new RegExp(`^${branch}-\\d+$`)
  const branches = refs.split("\n").filter((name) => name === branch || followUp.test(name))
  if (branches.length > 0) yield* runOk(["git", "branch", "-D", ...branches], { cwd: repoPath })
})

/** A branch that is not a session's never reaches a path: `""` would be the worktree root itself, everyone's worktrees in it. */
const sessionBranch = (branch: string): Effect.Effect<string, AdapterError> =>
  isSessionBranch(branch)
    ? Effect.succeed(branch)
    : Effect.fail(new AdapterError({ adapter: "git", operation: "worktree", message: `"${branch}" is not a session branch`, cause: null }))

export const WorktreesLive = Layer.sync(Worktrees)(() => {
  const locks = makeKeyedLock()
  return {
    create: (repoPath, branch) =>
      sessionBranch(branch).pipe(Effect.flatMap((valid) => create(repoPath, valid).pipe(locks.withLock(worktreePath(repoPath, valid))))),
    remove: (repoPath, branch, options) =>
      sessionBranch(branch).pipe(Effect.flatMap((valid) => remove(repoPath, valid, options).pipe(locks.withLock(worktreePath(repoPath, valid))))),
  }
})
