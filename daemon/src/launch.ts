import { BunRuntime } from "@effect/platform-bun"
import { Effect, Runtime, type Scope } from "effect"
import { type Env, readEnv } from "./config.ts"
import { decodeSecretsLine, readFirstLine, scrubProcessEnv, secretsFromEnv } from "./secrets.ts"

/**
 * How this daemon was started (docs/API.md "Launch"). Launched by the app, the
 * secrets arrive as one JSON line on stdin and the pipe stays open; its EOF means
 * the app is gone. In development they come from the env. Either way they leave
 * `process.env` before anything is bound or spawned.
 */
export interface Launch {
  readonly env: Env & { readonly apiToken: string }
  /** Settles when the app that launched us is gone (stdin EOF); undefined in development, where nothing watches stdin. */
  readonly closed: Promise<void> | undefined
}

/**
 * Reads the launch, or exits 1 when it carries no API token. `stdin` is opened only
 * with `BRIDGETOWN_SECRETS=stdin`; the mock passes its own branch of the pipe, so it
 * can read control lines after the secrets.
 */
export const readLaunch = async (stdin: () => ReadableStream<Uint8Array> = () => Bun.stdin.stream()): Promise<Launch> => {
  const piped = process.env.BRIDGETOWN_SECRETS === "stdin" ? await readFirstLine(stdin()) : undefined
  const secrets = piped === undefined ? secretsFromEnv(process.env) : decodeSecretsLine(piped.line ?? "")
  scrubProcessEnv()
  if (secrets === undefined) {
    console.error("BRIDGETOWN_SECRETS=stdin: expected one JSON line with an apiToken on stdin")
    process.exit(1)
  }
  const env = readEnv(secrets)
  const apiToken = env.apiToken
  if (apiToken === undefined) {
    console.error("No API token: launch with BRIDGETOWN_SECRETS=stdin, or set BRIDGETOWN_API_TOKEN for development")
    process.exit(1)
  }
  return { env: { ...env, apiToken }, closed: piped?.closed }
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
