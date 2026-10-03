import { describe, expect, test } from "bun:test"
import { metricsOf, windowStart } from "../src/api/metrics.ts"
import { makeSession } from "./fixtures/records.ts"

const now = new Date("2026-10-04T14:25:00.000Z")

describe("metrics", () => {
  test("the window is the current hour and the 23 before it", () => {
    expect(windowStart(now).toISOString()).toBe("2026-10-03T15:00:00.000Z")
  })

  test("alerts land in their hour by tone; older ones are dropped", () => {
    const m = metricsOf(
      now,
      [
        { receivedAt: "2026-10-04T14:01:00.000Z", tone: "live" },
        { receivedAt: "2026-10-04T14:20:00.000Z", tone: "neutral" },
        { receivedAt: "2026-10-04T13:59:59.000Z", tone: "failure" },
        { receivedAt: "2026-10-03T15:00:00.000Z", tone: "waiting" },
        { receivedAt: "2026-10-03T14:59:59.000Z", tone: "success" },
      ],
      [],
    )
    expect(m.alertsByHour).toHaveLength(24)
    expect(m.alertsByHour[0]).toEqual({ at: "2026-10-03T15:00:00.000Z", live: 0, waiting: 1, success: 0, neutral: 0, failure: 0 })
    expect(m.alertsByHour[22]).toMatchObject({ at: "2026-10-04T13:00:00.000Z", failure: 1 })
    expect(m.alertsByHour[23]).toMatchObject({ at: "2026-10-04T14:00:00.000Z", live: 1, neutral: 1 })
    const total = m.alertsByHour.reduce((n, b) => n + b.live + b.waiting + b.success + b.neutral + b.failure, 0)
    expect(total).toBe(4)
  })

  test("sessions count only when started in the window; closed and stopped are not resolved", () => {
    const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString()
    const m = metricsOf(now, [], [
      makeSession("resolved", { id: "a", startedAt: at(2), costUsd: 1.25 }),
      makeSession("closed", { id: "b", startedAt: at(3), costUsd: 0.5 }),
      makeSession("stopped", { id: "c", startedAt: at(4), costUsd: 0 }),
      makeSession("failed", { id: "d", startedAt: at(5), costUsd: 0.25 }),
      makeSession("running", { id: "e", startedAt: at(1), costUsd: 2 }),
      makeSession("resolved", { id: "old", startedAt: at(30), costUsd: 9 }),
    ])
    expect(m.sessions).toEqual({ started: 5, resolved: 1, failed: 1, closed: 2, costUsd: 4 })
  })
})
