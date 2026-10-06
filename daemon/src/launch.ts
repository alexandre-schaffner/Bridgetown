import { BunRuntime } from "@effect/platform-bun"
import { Effect, Runtime, type Scope } from "effect"
import { type Env, readEnv } from "./config.ts"
import { decodeSecretsLine, readFirstLine } from "./secrets.ts"

/**
 * How this daemon was started (docs/API.md "Launch"): by the app, with
 * `BRIDGETOWN_SECRETS=stdin` and the secrets as one JSON line on stdin. The pipe stays
 * open; its EOF means the app is gone. Secrets never come from the environment, where
 * the kernel keeps a copy any process of the user's can read (`ps -E`), a session's
 * included. In development `make dev` has the debug app launch the daemon from source.
 */
export interface Launch {
  readonly env: Env & { readonly apiToken: string }
  /** Settles when the app that launched us is gone (stdin EOF); undefined for the mock started by hand, where nothing watches stdin. */
  readonly closed: Promise<void> | undefined
}

/**
 * Reads the launch, or exits 1 when there is none: not started with
 * `BRIDGETOWN_SECRETS=stdin`, or no API token on the line. The mock passes its own
 * branch of the pipe, so it can read control lines after the secrets.
 */
export const readLaunch = async (stdin: ReadableStream<Uint8Array> = Bun.stdin.stream()): Promise<Launch> => {
  if (process.env.BRIDGETOWN_SECRETS !== "stdin") {
    console.error("The daemon reads its secrets from stdin, as the app launches it (BRIDGETOWN_SECRETS=stdin). Run it from source with `make dev`.")
    process.exit(1)
  }
  const { line, closed } = await readFirstLine(stdin)
  const secrets = decodeSecretsLine(line ?? "")
  if (secrets === undefined) {
    console.error("BRIDGETOWN_SECRETS=stdin: expected one JSON line with an apiToken on stdin")
    process.exit(1)
  }
  return { env: { ...readEnv(secrets), apiToken: secrets.apiToken }, closed }
}

const appGone = (closed: Promise<void>) =>
  Effect.promise(() => closed).pipe(Effect.andThen(Effect.logInfo("stdin closed: the app is gone, exiting")))

/**
 * Runs `program` until it ends or, launched by the app, until stdin closes;
 * either way its scope closes before the process exits with its status. The
 * server and the detached loops keep the event loop alive, so an ended program
 * has to exit explicitly.
 */
export const runDaemon = <A, E>(program: Effect.Effect<A, E, Scope.Scope>, launch: Launch): void => {
  const untilAppGone = launch.closed === undefined ? program : Effect.raceFirst(program, appGone(launch.closed))
  BunRuntime.runMain(Effect.scoped(untilAppGone), {
    teardown: (exit, onExit) =>
      Runtime.defaultTeardown(exit, (code) => {
        onExit(code)
        process.exit(code)
      }),
  })
}
