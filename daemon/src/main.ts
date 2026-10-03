import { BunRuntime } from "@effect/platform-bun"
import { Effect, Runtime } from "effect"
import { bind, serve } from "./api/server.ts"
import { gitOverHttpsEnv, readEnv } from "./config.ts"
import { Hub } from "./hub.ts"
import { appLayer } from "./layers.ts"
import { Scheduler } from "./scheduler.ts"
import { recoverInterrupted } from "./sessions/recovery.ts"
import { decodeSecretsLine, readFirstLine, scrubProcessEnv, secretsFromEnv } from "./secrets.ts"

Object.assign(process.env, gitOverHttpsEnv(process.env))

/**
 * Launched by the app, the secrets arrive as one JSON line on stdin and the pipe
 * stays open; its EOF means the app is gone. In development they come from the
 * env. Either way they leave `process.env` before anything is bound or spawned.
 */
const launch = process.env.BRIDGETOWN_SECRETS === "stdin" ? await readFirstLine(Bun.stdin.stream()) : undefined
const secrets = launch === undefined ? secretsFromEnv(process.env) : decodeSecretsLine(launch.line ?? "")
scrubProcessEnv()
if (secrets === undefined) {
  console.error("BRIDGETOWN_SECRETS=stdin: expected one JSON line with an apiToken on stdin")
  process.exit(1)
}
const env = readEnv(secrets)
if (env.apiToken === undefined) {
  console.error("No API token: launch with BRIDGETOWN_SECRETS=stdin, or set BRIDGETOWN_API_TOKEN for development")
  process.exit(1)
}
const token = env.apiToken
// Before the layers open the store: a second daemon exits 98 here.
const server = bind(env.port)

const stdinClosed = (closed: Promise<void>) =>
  Effect.promise(() => closed).pipe(Effect.andThen(Effect.logInfo("stdin closed: the app is gone, exiting")))

const program = Effect.gen(function* () {
  yield* recoverInterrupted
  yield* serve(server, { token })
  const hub = yield* Hub
  if (process.argv.includes("--paused")) yield* hub.patchStatus({ paused: true })
  if (env.forceDryRun) yield* Effect.logInfo("Dry run: nothing will be posted to Slack")
  yield* hub.notify
  const scheduler = yield* Scheduler
  if (launch === undefined) return yield* scheduler.run
  return yield* Effect.raceFirst(scheduler.run, stdinClosed(launch.closed))
})

BunRuntime.runMain(program.pipe(Effect.provide(appLayer(env))), {
  // The server and the detached loops keep the event loop alive, so an ended program exits explicitly.
  teardown: (exit, onExit) =>
    Runtime.defaultTeardown(exit, (code) => {
      onExit(code)
      process.exit(code)
    }),
})
