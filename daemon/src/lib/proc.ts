import { StringDecoder } from "node:string_decoder"
import { spawn } from "node:child_process"
import { Effect } from "effect"
import { AdapterError, errorMessage } from "../domain/errors.ts"
import { gitOverHttpsEnv } from "../config.ts"
import { childEnv } from "../secrets.ts"

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly stdin?: string
}

const DEFAULT_TIMEOUT_MS = 60_000

/** "git worktree add": the command and its first words, past any `-c key=value` before them. */
const operationOf = (command: ReadonlyArray<string>) => command.filter((arg, i) => arg !== "-c" && command[i - 1] !== "-c").slice(0, 3).join(" ")

/**
 * `git` as the daemon runs it in a repo an agent has written to: no hook it planted runs (`git worktree add` runs
 * post-checkout, `git branch -D` reference-transaction), nor an fsmonitor command its config names. Diffs add
 * `DIFF_FLAGS`, so no external diff or textconv driver runs either.
 */
export const git = (...args: ReadonlyArray<string>): ReadonlyArray<string> => ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args]

/** Checkout can run clean/smudge/process drivers even when working bytes are unchanged. */
export const gitWithoutFilters = (configKeys: string, command: ReadonlyArray<string>): ReadonlyArray<string> => {
  const drivers = new Set(configKeys.split("\0").flatMap((key) => {
    const driver = /^filter\.([\s\S]+)\.(?:clean|smudge|process|required)$/i.exec(key)?.[1]
    // Git -c splits at the first '='; such a subsection cannot be overridden safely.
    if (driver?.includes("=")) throw new Error("Unsupported Git filter name. Ask the user to prepare this checkout.")
    return driver === undefined ? [] : [driver]
  }))
  return git(...[...drivers].flatMap((driver) => [
    "-c", `filter.${driver}.clean=`, "-c", `filter.${driver}.smudge=`,
    "-c", `filter.${driver}.process=`, "-c", `filter.${driver}.required=false`,
  ]), ...command)
}

/** For `git diff`: the plain diff, never a driver from the repo's config. */
export const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"] as const

/** Capture a process with a hard output budget and kill its process group on every exit path. */
export const captureCommand = (command: ReadonlyArray<string>, options: RunOptions, signal: AbortSignal): Promise<CommandResult> => {
  const executable = command[0]
  if (executable === undefined || signal.aborted) return Promise.reject(new Error("Command unavailable or interrupted."))
  return new Promise((resolve, reject) => {
    const child = spawn(executable, command.slice(1), { cwd: options.cwd, env: options.env, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true })
    if (options.stdin !== undefined) { child.stdin?.on("error", () => {}); child.stdin?.end(options.stdin) }
    const outDecoder = new StringDecoder("utf8"), errDecoder = new StringDecoder("utf8")
    let stdout = "", stderr = "", bytes = 0
    let failure: Error | undefined
    const kill = () => {
      if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") } }
    }
    const stop = (error: Error) => { failure ??= error; kill() }
    const abort = () => stop(new Error("Command interrupted."))
    const timer = setTimeout(() => stop(new Error("Timed out: command.")), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    signal.addEventListener("abort", abort, { once: true })
    for (const [stream, kind] of [[child.stdout, "out"], [child.stderr, "err"]] as const) {
      stream?.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > (options.maxOutputBytes ?? 4 * 1024 * 1024)) return stop(new Error("Command output exceeded its limit. Narrow the request."))
        if (kind === "out") stdout += outDecoder.write(chunk)
        else stderr += errDecoder.write(chunk)
      })
    }
    child.on("error", (error) => { failure = error })
    // Background children must die before waiting for their inherited output pipes to close.
    child.on("exit", kill)
    child.on("close", (code) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      if (failure !== undefined) reject(failure)
      else resolve({ exitCode: code ?? 1, stdout: stdout + outDecoder.end(), stderr: stderr + errDecoder.end() })
    })
    if (signal.aborted) abort()
  })
}

/** Time, output and cancellation bounds for trusted utilities; generated commands additionally use the OS sandbox. */
export const run = (command: ReadonlyArray<string>, options: RunOptions = {}): Effect.Effect<CommandResult, AdapterError> =>
  Effect.tryPromise({
    try: (signal) => captureCommand(command, { ...options, env: { ...childEnv(process.env), ...(command[0] === "git" ? gitOverHttpsEnv({}) : {}), ...options.env } }, signal),
    catch: (cause) => new AdapterError({ adapter: "subprocess", operation: operationOf(command), message: errorMessage(cause), cause }),
  })

/** Like `run`, but a non-zero exit is a failure carrying stderr. */
export const runOk = (command: ReadonlyArray<string>, options: RunOptions = {}): Effect.Effect<string, AdapterError> =>
  run(command, options).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(
            new AdapterError({
              adapter: "subprocess",
              operation: operationOf(command),
              message: `exited ${result.exitCode}: ${result.stderr.trim().slice(0, 400)}`,
              cause: result,
            }),
          ),
    ),
  )
