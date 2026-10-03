import type { Session } from "../domain/model.ts"
import type { Tone } from "../domain/progress.ts"

/** The overview's telemetry: the last day of alerts and agent sessions, for the app's charts. */

export const METRICS_HOURS = 24
const HOUR_MS = 3_600_000

export type ToneCounts = Readonly<Record<Tone, number>>

export interface AlertBucket extends ToneCounts {
  /** Start of the hour, ISO. */
  readonly at: string
}

export interface Metrics {
  /** Start of the window (the oldest bucket's hour), ISO. */
  readonly since: string
  /** One per hour, oldest first, the current hour last. Each alert counts once, by its outcome's tone. */
  readonly alertsByHour: ReadonlyArray<AlertBucket>
  /** Sessions started in the window. */
  readonly sessions: {
    readonly started: number
    readonly resolved: number
    readonly failed: number
    /** Closed or stopped without a verified fix. */
    readonly closed: number
    readonly costUsd: number
  }
}

const zero = (): Record<Tone, number> => ({ live: 0, waiting: 0, success: 0, neutral: 0, failure: 0 })

/** The hour `now` falls in, and the 23 before it. */
export const windowStart = (now: Date): Date => {
  const hour = new Date(now)
  hour.setUTCMinutes(0, 0, 0)
  return new Date(hour.getTime() - (METRICS_HOURS - 1) * HOUR_MS)
}

/**
 * `alerts` are (receivedAt, tone) pairs; anything outside the window is dropped.
 * `sessions` are those touched in the window; only the ones started in it count.
 */
export const metricsOf = (
  now: Date,
  alerts: ReadonlyArray<{ readonly receivedAt: string; readonly tone: Tone }>,
  sessions: ReadonlyArray<Session>,
): Metrics => {
  const start = windowStart(now)
  const buckets = Array.from({ length: METRICS_HOURS }, zero)
  for (const alert of alerts) {
    const index = Math.floor((Date.parse(alert.receivedAt) - start.getTime()) / HOUR_MS)
    const bucket = buckets[index]
    if (bucket !== undefined) bucket[alert.tone] += 1
  }
  const started = sessions.filter((s) => Date.parse(s.startedAt) >= start.getTime())
  return {
    since: start.toISOString(),
    alertsByHour: buckets.map((counts, i) => ({ at: new Date(start.getTime() + i * HOUR_MS).toISOString(), ...counts })),
    sessions: {
      started: started.length,
      resolved: started.filter((s) => s.status === "resolved").length,
      failed: started.filter((s) => s.status === "failed").length,
      closed: started.filter((s) => s.status === "closed" || s.status === "stopped").length,
      costUsd: started.reduce((sum, s) => sum + s.costUsd, 0),
    },
  }
}
