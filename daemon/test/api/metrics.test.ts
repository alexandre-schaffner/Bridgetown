import { describe, expect, test } from "bun:test"
import { metricsOf } from "../../src/api/metrics.ts"
import { makeSession } from "../support/records.ts"

const now = new Date("2026-10-04T14:25:00.000Z")

describe("metrics", () => {
  test("sessions count only when started in the window; closed and stopped are not resolved", () => {
    const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString()
    const m = metricsOf(now, [
      makeSession("resolved", { id: "a", startedAt: at(2), costUsd: 1.25 }),
      makeSession("closed", { id: "b", startedAt: at(3), costUsd: 0.5 }),
      makeSession("stopped", { id: "c", startedAt: at(4), costUsd: 0 }),
      makeSession("failed", { id: "d", startedAt: at(5), costUsd: 0.25 }),
      makeSession("running", { id: "e", startedAt: at(1), costUsd: 2 }),
      makeSession("resolved", { id: "old", startedAt: at(30), costUsd: 9 }),
    ])
    expect(m.sessions).toEqual({ started: 5, resolved: 1 })
  })
})
