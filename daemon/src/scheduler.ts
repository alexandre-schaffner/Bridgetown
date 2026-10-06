import { Context, Duration, Effect, Layer, Record, Schedule } from "effect"
import { Critic } from "./critique/critic.ts"
import type { Settings } from "./domain/settings.ts"
import { Health } from "./health.ts"
import { Housekeeping } from "./housekeeping/housekeeping.ts"
import { Boards } from "./grafana/board.ts"
import { Hub } from "./hub.ts"
import { AlertPipeline } from "./pipeline/alerts.ts"
import { Inbox } from "./pipeline/inbox.ts"
import { SessionRunner } from "./sessions/runner.ts"
import { Shipper } from "./ship/shipper.ts"
import { Watcher } from "./watch/watcher.ts"

/** When a loop runs: `first` after startup, then `every` apart; an `every` read from the settings applies from the next round. */
export interface LoopTiming {
  readonly every: Duration.Input | ((settings: Settings) => Duration.Input)
  readonly first?: Duration.Input
}

export type LoopName = "github" | "poll" | "ship" | "critique" | "inbox" | "schedule" | "grafana" | "boards" | "watch" | "logs" | "housekeeping"

export type SchedulerTiming = Record.ReadonlyRecord<LoopName, LoopTiming>

/** The daemon's schedule. The mock daemon runs it with some loops sped up. */
export const SCHEDULER_TIMING: SchedulerTiming = {
  github: { every: "120 seconds", first: "120 seconds" },
  poll: { every: (s) => Duration.seconds(Math.max(10, s.pollSeconds)) },
  ship: { every: "60 seconds" },
  critique: { every: "10 seconds" },
  inbox: { every: (s) => Duration.seconds(Math.max(30, s.pollSeconds * 2)) },
  schedule: { every: "3 seconds" },
  grafana: { every: "60 seconds", first: "60 seconds" },
  boards: { every: "300 seconds" },
  watch: { every: "300 seconds", first: "90 seconds" },
  logs: { every: "600 seconds", first: "150 seconds" },
  // Well after startup's recovery and first polls; nothing it deletes is that urgent.
  housekeeping: { every: "1 hour", first: "2 minutes" },
}

export interface SchedulerShape {
  /** Runs the poll, inbox, ship, scheduling, health, prod watch and housekeeping loops on `timing` until interrupted. */
  readonly run: (timing?: SchedulerTiming) => Effect.Effect<never>
}

export class Scheduler extends Context.Service<Scheduler, SchedulerShape>()("Scheduler") {}

/**
 * Runs `effect` (after `first`) and then forever, `schedule` apart, on a fiber
 * of the caller's scope: closing it stops the loop. A failure is logged and the loop carries on.
 */
export const loop = <E, R>(name: string, effect: Effect.Effect<void, E, R>, schedule: Schedule.Schedule<unknown>, first: Duration.Input = Duration.zero) =>
  effect.pipe(
    Effect.catchCause((cause) => Effect.logWarning(`${name} failed`, cause)),
    Effect.repeat(schedule),
    Effect.delay(first),
    Effect.forkScoped,
  )

export const SchedulerLive = Layer.effect(Scheduler)(
  Effect.gen(function* () {
    const hub = yield* Hub
    const health = yield* Health
    const alerts = yield* AlertPipeline
    const inbox = yield* Inbox
    const shipper = yield* Shipper
    const critic = yield* Critic
    const runner = yield* SessionRunner
    const boards = yield* Boards
    const watcher = yield* Watcher
    const housekeeping = yield* Housekeeping

    // Sessions cannot fetch or push while GHE refuses this network, so they wait in the queue.
    const scheduleTick = Effect.gen(function* () {
      if ((yield* hub.status).github === "blocked") return
      yield* runner.tick
    })
    const loops: Record.ReadonlyRecord<LoopName, Effect.Effect<void, unknown>> = {
      github: health.probeGithub,
      poll: alerts.pollOnce,
      ship: shipper.tick,
      critique: critic.tick,
      inbox: inbox.poll,
      schedule: scheduleTick,
      grafana: health.probeGrafana,
      boards: boards.warm,
      watch: watcher.tick,
      logs: watcher.sweepLogs,
      housekeeping: housekeeping.run,
    }
    /** The wait before each next round, read again each time when it comes from the settings. */
    const spacing = ({ every }: LoopTiming): Schedule.Schedule<unknown> =>
      typeof every === "function" ? Schedule.forever.pipe(Schedule.modifyDelay(() => hub.settings.pipe(Effect.map(every)))) : Schedule.spaced(every)

    return {
      run: (timing = SCHEDULER_TIMING) =>
        Effect.scoped(
          Effect.gen(function* () {
            // Probed once before anything else, so the first poll and schedule rounds already know.
            yield* health.probeGrafana
            yield* health.probeGithub
            for (const [name, effect] of Record.toEntries(loops)) yield* loop(name, effect, spacing(timing[name]), timing[name].first)
            return yield* Effect.never
          }),
        ),
    }
  }),
)
