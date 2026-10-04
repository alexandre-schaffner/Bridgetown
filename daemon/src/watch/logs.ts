import type { ParsedAlert } from "../domain/alert.ts"
import type { LogPatternInput, LogPatternVerdict } from "./judge.ts"

/**
 * The log sweep: prod's error and warning lines grouped into patterns (one
 * message, numbers collapsed, from one job or service), the few worth a look
 * picked in code, and those judged by Jev in one batch.
 *
 * - Errors over the last day. A pattern is a candidate when it is new (not one
 *   line in the day before the last 15 minutes) or surging (at least 5× its
 *   usual rate). Patterns logged all day at the same rate are the normal noise.
 * - Warnings over the last 2 hours, only lines with a word that names a risk
 *   (deadlock, rate limited, retired…): 1.3M warning lines an hour make a day's
 *   grouping too heavy for VictoriaLogs (a 6-hour one answered 503). A risky
 *   warning is a candidate even when steady: a retirement notice never spikes.
 *
 * Queries are constants; nothing from a log line goes into one Bridgetown runs.
 */

export const RECENT_MINUTES = 15
export const MIN_RECENT = 10
const MIN_SURGE = 20
const SURGE_FACTOR = 5
/** Patterns per Jev call: three questions each. */
export const BATCH = 12

export type Sweep = "errors" | "warnings"

interface SweepSpec {
  readonly windowMinutes: number
  readonly levels: string
  /** Words a line must contain, or null for every line at those levels. */
  readonly words: string | null
}

export const SWEEPS: Readonly<Record<Sweep, SweepSpec>> = {
  errors: { windowMinutes: 24 * 60, levels: `(severity_text:="ERROR" OR severity_text:="FATAL")`, words: null },
  warnings: {
    windowMinutes: 2 * 60,
    levels: `(severity_text:="WARN" OR severity_text:="WARNING")`,
    words: [
      `(deadlock OR timeout OR "timed out" OR ECONNREFUSED OR ECONNRESET OR "rate limit" OR "rate limited" OR throttled OR deprecated`,
      `OR retired OR "will be removed" OR "out of memory" OR "insufficient funds" OR nonce OR reverted OR panic OR unhandled`,
      `OR "connection refused" OR exhausted OR corrupt OR inconsistent OR mismatch OR stale)`,
    ].join(" "),
  },
}

/** One row per pattern with a busy last 15 minutes: its counts, one real line, and the image tags that logged it. */
export const sweepQuery = (sweep: Sweep): string =>
  [
    SWEEPS[sweep].levels,
    ...(SWEEPS[sweep].words === null ? [] : [SWEEPS[sweep].words]),
    "| copy _msg as sample | collapse_nums | collapse_nums at merkl.job",
    `| stats by (merkl.job, k8s.deployment.name, k8s.container.name, _msg) count() total, count() if (_time:${RECENT_MINUTES}m) recent,`,
    "row_any(sample) sample, uniq_values(container.image.tag) limit 3 versions",
    `| filter recent:>=${MIN_RECENT} | sort by (recent desc) | limit 50`,
  ].join(" ")

export type Behaviour = "new" | "surging" | "steady"

/** One message pattern, merged across every job that logs it: one cause, one card. */
export interface LogPattern {
  readonly sweep: Sweep
  /** Stable across sweeps: the sweep and the collapsed message. */
  readonly key: string
  /** The jobs or services that logged it, busiest first, e.g. "merkl-compute-*". */
  readonly sources: ReadonlyArray<string>
  /** A LogsQL filter matching those sources, or null when one of them cannot be written safely. */
  readonly sourceFilter: string | null
  readonly message: string
  readonly example: string
  readonly versions: ReadonlyArray<string>
  /** Lines in the last 15 minutes, and the usual per 15 minutes over the rest of the window. */
  readonly recent: number
  readonly usual: number
  readonly behaviour: Behaviour
}

/** One row of a sweep: a pattern from one source. */
export interface PatternRow {
  readonly sweep: Sweep
  readonly source: string
  readonly sourceFilter: string | null
  readonly message: string
  readonly example: string
  readonly versions: ReadonlyArray<string>
  readonly recent: number
  readonly total: number
}

const parseJson = (text: string | undefined): unknown => {
  try {
    return JSON.parse(text ?? "")
  } catch {
    return undefined
  }
}

/** "merkl-compute-<N>" → a regex filter for it; anything outside a job name's characters gets no filter. */
const jobFilter = (job: string): string | null =>
  /^[a-z0-9.-]+(<N>[a-z0-9.-]*)*$/i.test(job) ? `merkl.job:~"^${job.replaceAll(".", "[.]").replaceAll("<N>", "[0-9]+")}$"` : null

const nameFilter = (field: string, name: string): string | null => (/^[a-z0-9.-]{1,80}$/i.test(name) ? `${field}:="${name}"` : null)

export const rowOf = (sweep: Sweep, row: Readonly<Record<string, string>>): PatternRow | undefined => {
  const recent = Number(row.recent)
  const total = Number(row.total)
  const message = (row._msg ?? "").trim()
  if (!Number.isFinite(recent) || !Number.isFinite(total) || message === "") return undefined
  const job = row["merkl.job"]
  const deployment = row["k8s.deployment.name"]
  const container = row["k8s.container.name"]
  const [source, sourceFilter] =
    job !== undefined && job !== ""
      ? [job.replaceAll("<N>", "*"), jobFilter(job)]
      : deployment !== undefined && deployment !== ""
        ? [deployment, nameFilter("k8s.deployment.name", deployment)]
        : [container ?? "unknown", container === undefined ? null : nameFilter("k8s.container.name", container)]
  const sample = parseJson(row.sample)
  const example = typeof sample === "object" && sample !== null && "sample" in sample && typeof sample.sample === "string" ? sample.sample : message
  const versions = parseJson(row.versions)
  return {
    sweep,
    source,
    sourceFilter,
    message,
    example: example.trim(),
    versions: Array.isArray(versions) ? versions.filter((v): v is string => typeof v === "string") : [],
    recent,
    total,
  }
}

export const behaviourOf = (sweep: Sweep, recent: number, total: number): { readonly usual: number; readonly behaviour: Behaviour } => {
  const usual = (total - recent) / ((SWEEPS[sweep].windowMinutes - RECENT_MINUTES) / RECENT_MINUTES)
  const behaviour: Behaviour = total === recent ? "new" : recent >= MIN_SURGE && recent >= SURGE_FACTOR * usual ? "surging" : "steady"
  return { usual, behaviour }
}

/** Rows with the same message from several jobs become one pattern, counts summed. */
export const mergeRows = (rows: ReadonlyArray<PatternRow>): ReadonlyArray<LogPattern> => {
  const groups = new Map<string, Array<PatternRow>>()
  for (const row of rows) {
    const key = `${row.sweep}:${String(Bun.hash(row.message))}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.entries()].flatMap(([key, group]) => {
    const busiest = [...group].sort((a, b) => b.recent - a.recent)
    const first = busiest[0]
    if (first === undefined) return []
    const recent = group.reduce((sum, row) => sum + row.recent, 0)
    const total = group.reduce((sum, row) => sum + row.total, 0)
    const filters = busiest.map((row) => row.sourceFilter)
    const sourceFilter = filters.some((f) => f === null) ? null : filters.length === 1 ? (filters[0] ?? null) : `(${filters.join(" OR ")})`
    return [
      {
        sweep: first.sweep,
        key,
        sources: busiest.map((row) => row.source),
        sourceFilter,
        message: first.message,
        example: first.example,
        versions: [...new Set(busiest.flatMap((row) => row.versions))].slice(0, 3),
        recent,
        ...behaviourOf(first.sweep, recent, total),
      },
    ]
  })
}

const RANK: Readonly<Record<Behaviour, number>> = { new: 0, surging: 1, steady: 2 }

/**
 * The patterns worth asking Jev about, most telling first: new errors, then
 * surges, then risky warnings. Steady errors are the day's normal noise, and a
 * pattern judged in the last day is not asked about again.
 */
export const candidates = (patterns: ReadonlyArray<LogPattern>, judged: ReadonlySet<string>): ReadonlyArray<LogPattern> =>
  patterns
    .filter((p) => !judged.has(p.key) && p.recent >= MIN_RECENT && (p.sweep === "warnings" || p.behaviour !== "steady"))
    .sort((a, b) => RANK[a.behaviour] - RANK[b.behaviour] || b.recent - a.recent)
    .slice(0, BATCH)

/** "merkl-compute-*", or "merkl-compute-* and 2 more". */
export const sourcesText = (p: LogPattern): string =>
  p.sources.length <= 1 ? (p.sources[0] ?? "unknown") : `${p.sources[0]} and ${p.sources.length - 1} more`

const window = (sweep: Sweep) => (sweep === "errors" ? "the day" : "the 2 hours")

/** What the pattern did, in words, so Jev never compares numbers. */
export const behaviourText = (p: LogPattern): string => {
  const lines = `${p.recent.toLocaleString("en-US")} lines in the last ${RECENT_MINUTES} minutes`
  switch (p.behaviour) {
    case "new":
      return `New: ${lines}, and none in ${window(p.sweep)} before.`
    case "surging":
      return `Surging: ${lines}, about ${Math.round(p.recent / p.usual)}× its usual rate over ${window(p.sweep)} before.`
    case "steady":
      return `Steady: ${lines}, about as often as over ${window(p.sweep)} before.`
  }
}

export const judgeInput = (p: LogPattern): LogPatternInput => ({
  source: p.sources.join(", "),
  message: p.message,
  example: p.example,
  level: p.sweep === "errors" ? "error" : "warning",
  behaviour: behaviourText(p),
  versions: p.versions,
})

/** The longest run of plain words in the message, to find its lines again; null when there is none worth quoting. */
const phraseOf = (message: string): string | null => {
  const runs = message.split(/<N>|[^A-Za-z ]+/).map((run) => run.trim().replace(/\s+/g, " "))
  const longest = runs.reduce((a, b) => (b.length > a.length ? b : a), "")
  if (longest.length < 12) return null
  // Whole words only: a phrase filter does not match "remove" inside "removed".
  return longest.length <= 60 ? longest : longest.slice(0, 61).replace(/\s+\S*$/, "")
}

/** A LogsQL query an agent can run through the grafana MCP to see the pattern's lines. */
export const linesQuery = (p: LogPattern): string => {
  const phrase = phraseOf(p.message)
  return [SWEEPS[p.sweep].levels, p.sourceFilter, phrase === null ? null : `"${phrase}"`].filter((part) => part !== null).join(" ")
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const clock = (date: Date) => `${date.toISOString().slice(11, 16)} UTC`

/** A judged pattern as an alert Bridgetown raised itself, in channel "Grafana" like the metric findings. */
export const logFinding = (p: LogPattern, verdict: LogPatternVerdict, now: Date, link: string): ParsedAlert => {
  const since = new Date(now.getTime() - RECENT_MINUTES * 60_000)
  const kind = p.sweep === "errors" ? "error" : "warning"
  const title = oneLine(`${sourcesText(p)}: ${p.behaviour === "steady" ? "" : `${p.behaviour} ${kind} · `}${oneLine(p.example, 200)}`, 110)
  const summary = [
    `${behaviourText(p)} Logged by ${p.sources.join(", ")}${p.versions.length === 0 ? "" : ` (${p.versions.join(", ")})`} at ${kind} level since ${clock(since)}.`,
    "Bridgetown found this in the logs; no Slack alert has fired for it.",
  ].join(" ")
  const query = linesQuery(p)
  const seconds = String(Math.floor(since.getTime() / 1000))
  const id = String(Bun.hash(p.key))
  return {
    id: `watch:log:${id}:${seconds}`,
    channelId: "grafana",
    channelName: "Grafana",
    ts: seconds,
    title,
    summary,
    raw: [
      title,
      summary,
      `Pattern (numbers collapsed to <N>): ${oneLine(p.message, 600)}`,
      `Example line: ${oneLine(p.example, 600)}`,
      `Find its lines (VictoriaLogs, LogsQL): ${query}`,
      `Jev: problem ${Math.round(verdict.problem * 100)}% · agent ${Math.round(verdict.agent * 100)}% · users affected ${Math.round(verdict.users * 100)}%`,
      `Dashboard: ${link}`,
    ].join("\n"),
    source: "watch",
    fingerprint: `watch:log:${id}`,
    fields: { _tag: "watch", signal: `log:${id}`, query, datasource: "logs", level: p.recent, usual: Math.round(p.usual * 10) / 10, since: since.toISOString() },
    mentionsMe: false,
    fromHuman: false,
  }
}
