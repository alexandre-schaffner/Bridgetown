import { Effect } from "effect"
import { bind, serve } from "./api/server.ts"
import { gitOverHttpsEnv } from "./config.ts"
import { Hub } from "./hub.ts"
import { appLayer } from "./layers.ts"
import { readLaunch, runDaemon } from "./launch.ts"
import { Scheduler } from "./scheduler.ts"
import { recoverInterrupted } from "./sessions/recovery.ts"

Object.assign(process.env, gitOverHttpsEnv(process.env))

const launch = await readLaunch()
const { env } = launch
// Before the layers open the store: a second daemon exits 98 here.
const server = bind(env.port)

const program = Effect.gen(function* () {
  yield* recoverInterrupted
  yield* serve(server, { token: env.apiToken })
  const hub = yield* Hub
  if (process.argv.includes("--paused")) yield* hub.patchStatus({ paused: true })
  if (env.forceDryRun) yield* Effect.logInfo("Dry run: nothing will be posted to Slack")
  yield* hub.notify
  return yield* (yield* Scheduler).run
})

runDaemon(program.pipe(Effect.provide(appLayer(env))), launch)
