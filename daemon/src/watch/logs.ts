import { Schema } from "effect"
import { type Decision, type ParsedAlert, type Triage, WATCH_CHANNEL } from "../domain/alert.ts"
import { exploreLogsLink } from "../grafana/boards.ts"
import { ERROR_LEVELS, regexLiteral, WARNING_LEVELS } from "../grafana/logsql.ts"
import { clock, oneLine, pct } from "../lib/text.ts"
import { watchFingerprint } from "./detect.ts"
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

const RECENT_MINUTES = 15
const MIN_RECENT = 10
const MIN_SURGE = 20
const SURGE_FACTOR = 5
/** Patterns per Jev call: three questions each. */
export const BATCH = 12

export const Sweep = Schema.Literals(["errors", "warnings"])
export type Sweep = typeof Sweep.Type

interface SweepSpec {
  readonly windowMinutes: number
  readonly levels: string
  /** Words a line must contain, or null for every line at those levels. */
  readonly words: string | null
}

export const SWEEPS: Readonly<Record<Sweep, SweepSpec>> = {
  errors: { windowMinutes: 24 * 60, levels: ERROR_LEVELS, words: null },
  warnings: {
    windowMinutes: 2 * 60,
    levels: WARNING_LEVELS,
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

export const Behaviour = Schema.Literals(["new", "surging", "steady"])
export type Behaviour = typeof Behaviour.Type

/** One message pattern, merged across every job that logs it: one cause, one card. Kept across restarts (sweep-store.ts). */
export const LogPattern = Schema.Struct({
  sweep: Sweep,
  /** Stable across sweeps: the sweep and the collapsed message (`patternKey`). */
  key: Schema.String,
  /** The jobs or services that logged it, busiest first, e.g. "merkl-compute-*". */
  sources: Schema.Array(Schema.String),
  /** A LogsQL filter matching those sources, or null when one of them cannot be written safely. */
  sourceFilter: Schema.NullOr(Schema.String),
  message: Schema.String,
  example: Schema.String,
  versions: Schema.Array(Schema.String),
  /** Lines in the last 15 minutes, and the usual per 15 minutes over the rest of the window. */
  recent: Schema.Number,
  usual: Schema.Number,
  behaviour: Behaviour,
})
export type LogPattern = typeof LogPattern.Type

/** Nested RPC wrappers sometimes append the same cause again ("out of gas: out of gas"). */
const patternMessage = (message: string): string => message.replace(/\b([a-z][a-z0-9_]*(?: [a-z][a-z0-9_]*){0,7})(?:: \1)+\b/g, "$1")

export const patternKey = (sweep: Sweep, message: string): string => `${sweep}:${String(Bun.hash(patternMessage(message)))}`

export const levelOf = (sweep: Sweep) => (sweep === "errors" ? ("error" as const) : ("warning" as const))

/** `usual` to one decimal, as findings and the app show it. */
export const shownUsual = (p: LogPattern): number => Math.round(p.usual * 10) / 10

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
  /^[a-z0-9.-]+(<N>[a-z0-9.-]*)*$/i.test(job) ? `merkl.job:~"^${regexLiteral(job).replaceAll("<N>", "[0-9]+")}$"` : null

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
    const key = patternKey(row.sweep, row.message)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.entries()].flatMap(([key, group]) => {
    const busiest = [...group].sort((a, b) => b.recent - a.recent)
    const first = busiest[0]
    if (first === undefined) return []
    const recent = group.reduce((sum, row) => sum + row.recent, 0)
    const total = group.reduce((sum, row) => sum + row.total, 0)
    const filters = [...new Set(busiest.map((row) => row.sourceFilter))]
    const sourceFilter = filters.some((f) => f === null) ? null : filters.length === 1 ? (filters[0] ?? null) : `(${filters.join(" OR ")})`
    return [
      {
        sweep: first.sweep,
        key,
        sources: [...new Set(busiest.map((row) => row.source))],
        sourceFilter,
        message: patternMessage(first.message),
        example: first.example,
        versions: [...new Set(busiest.flatMap((row) => row.versions))].slice(0, 3),
        recent,
        ...behaviourOf(first.sweep, recent, total),
      },
    ]
  })
}

const RANK: Readonly<Record<Behaviour, number>> = { new: 0, surging: 1, steady: 2 }

/** New or surging errors, and any risky warning: steady errors are the day's normal noise. */
export const suspicious = (p: LogPattern): boolean => p.recent >= MIN_RECENT && (p.sweep === "warnings" || p.behaviour !== "steady")

/** Most telling first: new errors, then surges, then risky warnings, then the steady noise; busiest first within each. */
export const byConcern = (a: LogPattern, b: LogPattern) =>
  Number(suspicious(b)) - Number(suspicious(a)) || RANK[a.behaviour] - RANK[b.behaviour] || b.recent - a.recent

/** The patterns worth asking Jev about, most telling first. A pattern judged in the last day is not asked about again. */
export const candidates = (patterns: ReadonlyArray<LogPattern>, judged: ReadonlySet<string>): ReadonlyArray<LogPattern> =>
  patterns
    .filter((p) => !judged.has(p.key) && suspicious(p))
    .sort(byConcern)
    .slice(0, BATCH)

/** "merkl-compute-*", or "merkl-compute-* and 2 more". */
const sourcesText = (p: LogPattern): string =>
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
  level: levelOf(p.sweep),
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

/** How far before a sweep its Grafana links look. */
const LINK_HOURS = 3

/** The pattern's lines in Grafana Explore, from 3 hours before the sweep that saw it to `to`. */
export const patternLink = (p: LogPattern, sweptAt: Date, to: Date = sweptAt): string =>
  exploreLogsLink(linesQuery(p), new Date(sweptAt.getTime() - LINK_HOURS * 3_600_000), to)

/** Prod's error lines in Grafana Explore over the 3 hours to `now`. */
export const errorsLink = (now: Date): string => exploreLogsLink(SWEEPS.errors.levels, new Date(now.getTime() - LINK_HOURS * 3_600_000), now)

/** A judged pattern as an alert Bridgetown raised itself, in channel "Grafana" like the metric findings. */
export const logFinding = (p: LogPattern, verdict: LogPatternVerdict, now: Date): ParsedAlert => {
  const since = new Date(now.getTime() - RECENT_MINUTES * 60_000)
  const kind = levelOf(p.sweep)
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
    channelId: WATCH_CHANNEL.id,
    channelName: WATCH_CHANNEL.name,
    ts: seconds,
    title,
    summary,
    raw: [
      title,
      summary,
      `Pattern (numbers collapsed to <N>): ${oneLine(p.message, 600)}`,
      `Example line: ${oneLine(p.example, 600)}`,
      `Find its lines (VictoriaLogs, LogsQL): ${query}`,
      `Jev: problem ${pct(verdict.problem)} · agent ${pct(verdict.agent)} · users affected ${pct(verdict.users)}`,
      `Dashboard: ${patternLink(p, now)}`,
    ].join("\n"),
    source: "watch",
    fingerprint: watchFingerprint(`log:${id}`),
    fields: { _tag: "watch", signal: `log:${id}`, query, datasource: "logs", level: p.recent, usual: shownUsual(p), since: since.toISOString(), shape: "rise" },
    mentionsMe: false,
  }
}

/**
 * A pattern Jev calls a problem is an anomaly: it gets an investigation, like a metric's (`decideAnomaly`), unless
 * the sweep has started enough already and it is only suggested.
 */
export const logTriage = (verdict: LogPatternVerdict, decision: Extract<Decision, "auto" | "suggest">): Triage => ({
  decision,
  reason: `Anomaly in the logs, ${decision === "auto" ? "investigating" : "suggested"} (Jev: problem ${pct(verdict.problem)} · agent ${pct(verdict.agent)} · users ${pct(verdict.users)})`,
  jev: { actionable: verdict.problem, agentResolvable: verdict.agent, humanOnIt: 0, kind: "runtime_error", kindConfidence: 0, depth: "standard", urgency: 3 * verdict.users },
})
