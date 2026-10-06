import { accessSync, constants, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { appSupportDir } from "../config.ts"
import { EXEC_GUARDED, execRefusal, type GuardContext, readScript } from "./guard.ts"
import { GIT_VALUE_OPTIONS } from "./guard-vcs.ts"

/**
 * The exec-time backstop to the command-line guard. Every session's PATH starts with
 * a directory of shims, one per command in `EXEC_GUARDED`, each a few lines of sh that
 * hand the real argv to `bridgetown-daemon --guard-exec` and exec the real binary only
 * if the same policy allows it. That catches what a check of the command line cannot
 * see: a package.json script or Makefile recipe, a command a program spawns (`bun x.ts`,
 * `node -e`), a variable that holds the command (`x=gh; $x pr merge 1`), a git hook.
 * A program that calls a binary by its absolute path, or with a PATH of its own, still
 * goes around it: this is a backstop for what runs out of sight, not a sandbox. The
 * command-line guard judges an absolute path by its name.
 */

/** Where the shims live: outside every worktree, where the session's write tools are refused. */
export const shimDir = (): string => join(appSupportDir(), "guard-bin")

/** How a shim runs the guard: this compiled daemon itself, or bun on main.ts from source. */
export const guardRunner = (): ReadonlyArray<string> =>
  import.meta.url.includes("$bunfs") ? [process.execPath] : [process.execPath, fileURLToPath(new URL("../main.ts", import.meta.url))]

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * One shim. The guard runs from `/` with nothing but PATH in its environment, so
 * nothing the session controls reaches it: a `bunfig.toml` preload or `.env` in the
 * worktree, `BUN_OPTIONS`. It gets the cwd and the session's branch as arguments and
 * prints the real binary's path, or exits 126 with the reason on stderr.
 */
const shim = (name: string, dir: string, daemonPort: number, runner: ReadonlyArray<string>): string =>
  [
    "#!/bin/sh",
    `# Bridgetown's exec-time guard (daemon/src/sessions/guard-exec.ts): ${name} runs only if the session's command policy allows it.`,
    "cwd=$PWD",
    `real=$(cd / && exec /usr/bin/env -i PATH="$PATH" ${runner.map(quote).join(" ")} --guard-exec ${quote(dir)} ${daemonPort} "$cwd" "\${BRIDGETOWN_BRANCH-}" ${name} "$@") || exit`,
    'exec "$real" "$@"',
    "",
  ].join("\n")

const readOrUndefined = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/**
 * Writes `dir`'s shims, read-only, and removes anything else there. Run before every
 * turn, so a shim the session deleted or rewrote, or one naming a daemon that has
 * moved, is put back. Each is replaced whole, so a concurrent session never runs half of one.
 */
export const installShims = (dir: string, daemonPort: number, runner: ReadonlyArray<string> = guardRunner()): void => {
  mkdirSync(dir, { recursive: true })
  const names = new Set(EXEC_GUARDED)
  for (const entry of readdirSync(dir)) if (!names.has(entry)) rmSync(join(dir, entry), { recursive: true, force: true })
  for (const name of names) {
    const path = join(dir, name)
    const content = shim(name, dir, daemonPort, runner)
    if (readOrUndefined(path) === content) continue
    const staging = `${path}.${process.pid}`
    writeFileSync(staging, content, { mode: 0o555 })
    renameSync(staging, path)
  }
}

const sameFile = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/** The real `name`: the first executable on `path` outside the shim directory. Relative entries resolve in the worktree, where the session writes, so they are skipped. */
export const realBinary = (name: string, path: string, shims: string): string | undefined => {
  for (const dir of path.split(":")) {
    if (!isAbsolute(dir) || sameFile(dir, shims)) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not here; next entry.
    }
  }
  return undefined
}

/** gh's own credential helper, as gh passes it to the git it runs: `credential.<url>.helper=!"/opt/homebrew/bin/gh" auth git-credential`. */
const GH_CREDENTIAL_HELPER = /^credential\.(.+\.)?helper=!"?([^"]+)"? auth git-credential$/i

/**
 * The argv with the credential plumbing gh and git run on their own taken out, as no
 * agent types it and the command-line policy would refuse it: gh passes the git it
 * runs its own credential helper (by its real path, or by name, which comes back
 * through its shim), git runs `gh auth git-credential` (config.ts's helper) on a push
 * or fetch, and git-lfs asks `git credential fill`, which is judged by its options
 * alone. Anything else stays for the policy.
 */
const withoutPlumbing = (name: string, args: ReadonlyArray<string>, path: string, shims: string): ReadonlyArray<string> | undefined => {
  if (name === "gh" && args[0] === "auth" && args[1] === "git-credential") return undefined
  if (name !== "git") return args
  const ghHelper = (setting: string | undefined): boolean => {
    const gh = GH_CREDENTIAL_HELPER.exec(setting ?? "")?.[2]
    if (gh === undefined) return false
    const real = realBinary("gh", path, shims)
    return gh === "gh" || (real !== undefined && sameFile(gh, real))
  }
  const dropped = new Set<number>()
  let at = 0
  while (at < args.length && args[at]?.startsWith("-")) {
    const option = args[at] ?? ""
    if (option === "-c" && ghHelper(args[at + 1])) dropped.add(at).add(at + 1)
    at += GIT_VALUE_OPTIONS.has(option) ? 2 : 1
  }
  return args.filter((_, i) => !dropped.has(i) && (args[at] !== "credential" || i < at))
}

export interface ExecRequest {
  readonly name: string
  readonly args: ReadonlyArray<string>
  /** The shim directory, skipped when looking for the real binary. */
  readonly shims: string
  readonly context: GuardContext
}

export type ExecVerdict =
  | { readonly _tag: "Run"; readonly path: string }
  | { readonly _tag: "Refused"; readonly reason: string }
  | { readonly _tag: "NotFound" }

/** What a shim does with `name args…`: the same policy as the command line, on the argv as it really is. */
export const execVerdict = ({ name, args, shims, context }: ExecRequest, path: string): ExecVerdict => {
  const checked = withoutPlumbing(name, args, path, shims)
  const reason = checked === undefined ? undefined : execRefusal(name, checked, context)
  if (reason !== undefined) return { _tag: "Refused", reason }
  const real = realBinary(name, path, shims)
  return real === undefined ? { _tag: "NotFound" } : { _tag: "Run", path: real }
}

/** `--guard-exec <shim dir> <daemon port> <cwd> <branch> <name> [args…]`, as a shim runs it. */
export const guardExecMain = (argv: ReadonlyArray<string>): never => {
  const [shims = "", port = "", cwd = "", branch = "", name = "", ...args] = argv
  const context: GuardContext = { branch, cwd: cwd === "" ? "/" : cwd, daemonPort: Number(port), readFile: readScript }
  const verdict = execVerdict({ name, args, shims, context }, process.env.PATH ?? "")
  switch (verdict._tag) {
    case "Run":
      writeSync(1, verdict.path)
      return process.exit(0)
    case "Refused": {
      const command = [name, ...args].join(" ")
      writeSync(2, `Bridgetown refused \`${command.length > 200 ? `${command.slice(0, 200)}…` : command}\`: ${verdict.reason}\n`)
      return process.exit(126)
    }
    case "NotFound":
      writeSync(2, `${name}: command not found\n`)
      return process.exit(127)
  }
}
