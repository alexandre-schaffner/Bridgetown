import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { Critic } from "./critique/critic.ts"
import { Health } from "./health.ts"
import { Housekeeping } from "./housekeeping/housekeeping.ts"
import { Boards } from "./grafana/board.ts"
import { Hub } from "./hub.ts"
import { AlertPipeline } from "./pipeline/alerts.ts"
import { Inbox } from "./pipeline/inbox.ts"
import { SessionRunner } from "./sessions/runner.ts"
import { Shipper } from "./ship/shipper.ts"
import { Watcher } from "./watch/watcher.ts"

export interface SchedulerShape {
  /** Runs the poll, inbox, ship, scheduling, health, prod watch and housekeeping loops until interrupted. */
  readonly run: Effect.Effect<never>
}

export class Scheduler extends Context.Service<Scheduler, SchedulerShape>()("Scheduler") {}

/** `every` is read again before each wait, so a settings change applies from the next round. */
const spacedBy = (every: Effect.Effect<Duration.Input>) => Schedule.forever.pipe(Schedule.modifyDelay(() => every))

/**
 * Runs `effect` (after `first`) and then forever, `schedule` apart, on a fiber
 * of the caller's scope: closing it stops the loop. A failure is logged and the loop carries on.
 */
const loop = <E>(name: string, effect: Effect.Effect<void, E>, schedule: Schedule.Schedule<unknown>, first: Duration.Input = Duration.zero) =>
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
    const seconds = (pick: (pollSeconds: number) => number) =>
      hub.settings.pipe(Effect.map((s): Duration.Input => Duration.seconds(pick(s.pollSeconds))))

    return {
      run: Effect.scoped(
        Effect.gen(function* () {
          // Probed once before anything else, so the first poll and schedule rounds already know.
          yield* health.probeGrafana
          yield* health.probeGithub
          yield* loop("github", health.probeGithub, Schedule.spaced("120 seconds"), "120 seconds")
          yield* loop("poll", alerts.pollOnce, spacedBy(seconds((poll) => Math.max(10, poll))))
          yield* loop("ship", shipper.tick, Schedule.spaced("60 seconds"))
          yield* loop("critique", critic.tick, Schedule.spaced("10 seconds"))
          yield* loop("inbox", inbox.poll, spacedBy(seconds((poll) => Math.max(30, poll * 2))))
          yield* loop("schedule", scheduleTick, Schedule.spaced("3 seconds"))
          yield* loop("grafana", health.probeGrafana, Schedule.spaced("60 seconds"), "60 seconds")
          yield* loop("boards", boards.warm, Schedule.spaced("300 seconds"))
          yield* loop("watch", watcher.tick, Schedule.spaced("300 seconds"), "90 seconds")
          yield* loop("logs", watcher.sweepLogs, Schedule.spaced("600 seconds"), "150 seconds")
          // Well after startup's recovery and first polls; nothing it deletes is that urgent.
          yield* loop("housekeeping", housekeeping.run, Schedule.spaced("1 hour"), "2 minutes")
          return yield* Effect.never
        }),
      ),
    }
  }),
)
