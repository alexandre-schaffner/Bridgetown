import { describe, expect, test } from "bun:test"
import { Duration, Effect, Fiber, Record } from "effect"
import { DEFAULT_SETTINGS } from "../src/domain/settings.ts"
import { Hub } from "../src/hub.ts"
import { SCHEDULER_TIMING, Scheduler, type SchedulerTiming } from "../src/scheduler.ts"
import { fakeGitHub, fakeSlack } from "./support/fakes.ts"
import { eventually } from "./support/wait.ts"
import { makeWorld } from "./support/world.ts"

describe("the scheduler", () => {
  test("runs each loop on the timing it is given: after its first delay, then spaced as it, or the settings, say", async () => {
    const calls = { reads: 0, probes: 0 }
    const world = makeWorld({
      slack: fakeSlack({ latest: () => Effect.sync(() => void calls.reads++).pipe(Effect.as([])) }),
      github: fakeGitHub({ reachability: Effect.sync(() => void calls.probes++).pipe(Effect.as("ok" as const)) }),
    })
    // Every loop every 10 ms but two: the alert poll as many ms apart as the settings' pollSeconds, and the GHE probe
    // not before an hour, so only startup's probe runs.
    const timing: SchedulerTiming = {
      ...Record.map(SCHEDULER_TIMING, () => ({ every: "10 millis" })),
      poll: { every: (s) => Duration.millis(s.pollSeconds) },
      github: { every: "10 millis", first: "1 hour" },
    }
    const channels = DEFAULT_SETTINGS.channels.filter((c) => c.enabled).length
    const reads = Effect.sync(() => calls.reads)
    try {
      const rounds = await world.runPromise(
        Effect.gen(function* () {
          const hub = yield* Hub
          yield* hub.updateSettings({ ...(yield* hub.settings), pollSeconds: 1_000 })
          const running = yield* (yield* Scheduler).run(timing).pipe(Effect.forkChild)
          // The first round reads every enabled channel once, at once; the next one is a second after it.
          yield* eventually(reads, (n) => (n >= channels ? n : undefined))
          yield* Effect.sleep("200 millis")
          const once = calls.reads
          yield* hub.updateSettings({ ...(yield* hub.settings), pollSeconds: 10 })
          // The wait already under way runs out first; then rounds are 10 ms apart.
          const later = yield* eventually(reads, (n) => (n > 10 * channels ? n : undefined), 5_000)
          yield* Fiber.interrupt(running)
          return { once, later }
        }),
      )
      expect(calls.probes).toBe(1)
      expect(rounds.once).toBe(channels)
      expect(rounds.later).toBeGreaterThan(10 * channels)
    } finally {
      await world.dispose()
    }
  })
})
