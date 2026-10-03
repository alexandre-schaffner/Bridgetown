import { Effect } from "effect"
import { AdapterError, attempt, errorMessage } from "./domain/errors.ts"
import { childEnv } from "./secrets.ts"

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

const operationOf = (command: ReadonlyArray<string>) => command.slice(0, 3).join(" ")

/** The child lives as long as the scope: closing it (done, timed out, interrupted) kills a child that is still running. */
const spawn = (command: ReadonlyArray<string>, options: RunOptions) =>
  Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn([...command], {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: { ...childEnv(process.env), ...options.env },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        }),
      catch: (cause) => new AdapterError({ adapter: "subprocess", operation: operationOf(command), message: errorMessage(cause), cause }),
    }),
    (child) => Effect.sync(() => (child.exitCode === null ? child.kill() : undefined)),
  )

/**
 * Bounded subprocess: a hung `git fetch` or `gh` call must not stall a loop
 * forever. Interrupting the effect (a timeout, a stopped session, shutdown)
 * kills the child. Children never inherit a credential (see `childEnv`).
 */
export const run = (command: ReadonlyArray<string>, options: RunOptions = {}): Effect.Effect<CommandResult, AdapterError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawn(command, options)
      const [exitCode, stdout, stderr] = yield* attempt("subprocess", operationOf(command), () =>
        Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
      )
      return { exitCode, stdout, stderr }
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(new AdapterError({ adapter: "subprocess", operation: operationOf(command), message: `Timed out: ${command.join(" ")}`, cause: null })),
    }),
  )

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
