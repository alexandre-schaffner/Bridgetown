/** The one clock and id source, so every record is stamped and named the same way. */
export const now = (): string => new Date().toISOString()

/** `a_…` for actions, `s_…` for sessions: time-ordered, short, unique enough for one machine. */
export const newId = (prefix: "a" | "s"): string => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** A Slack `ts` (`"1790933006.433649"`) as an ISO timestamp. */
export const tsToIso = (ts: string): string => new Date(Number(ts) * 1000).toISOString()

export const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString()
