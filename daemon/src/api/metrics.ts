import type { Session } from "../domain/session.ts"

/** The overview's numbers over the last day. */

const DAY_MS = 86_400_000

export interface Metrics {
  /** Start of the window, ISO. */
  readonly since: string
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

export const windowStart = (now: Date): Date => new Date(now.getTime() - DAY_MS)

/** `sessions` are those touched in the window; only the ones started in it count. */
export const metricsOf = (now: Date, sessions: ReadonlyArray<Session>): Metrics => {
  const start = windowStart(now)
  const started = sessions.filter((s) => Date.parse(s.startedAt) >= start.getTime())
  return {
    since: start.toISOString(),
    sessions: {
      started: started.length,
      resolved: started.filter((s) => s.status === "resolved").length,
      failed: started.filter((s) => s.status === "failed").length,
      closed: started.filter((s) => s.status === "closed" || s.status === "stopped").length,
      costUsd: started.reduce((sum, s) => sum + s.costUsd, 0),
    },
  }
}
