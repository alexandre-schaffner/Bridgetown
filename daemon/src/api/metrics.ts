import type { Session } from "../domain/session.ts"
import type { Metrics } from "./wire.ts"

/** The overview's numbers over the last day. */

const DAY_MS = 86_400_000

export const windowStart = (now: Date): Date => new Date(now.getTime() - DAY_MS)

/** `sessions` are those touched in the window; only the ones started in it count. */
export const metricsOf = (now: Date, sessions: ReadonlyArray<Session>): Metrics => {
  const started = sessions.filter((s) => Date.parse(s.startedAt) >= windowStart(now).getTime())
  return { sessions: { started: started.length, resolved: started.filter((s) => s.status === "resolved").length } }
}
