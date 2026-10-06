import { type ParsedAlert, WATCH_CHANNEL } from "../domain/alert.ts"
import type { Deploy, Panel } from "../grafana/board.ts"
import { type PanelSpec, type Unit, WATCH_HOURS } from "../grafana/boards.ts"

/**
 * Two kinds of anomaly, each against the 90th percentile of the steps before the last three (15 minutes):
 * - a rise: the median of the last three complete steps is at least `floor` and above `factor` × that usual
 *   level, so two of the three steps are up;
 * - a spike: one of them alone is at least `spike.floor` and above `spike.factor` × it.
 * On a normal day (2026-10-03) API 5xx sit near 3 per 5 minutes with one-step bursts to 100–470, and engine and
 * job errors swing 10–600 as jobs run. Replayed on that day, API 5xx spike 9 times (2 findings after the
 * cooldown, which Jev, seeing nothing in them, leaves as suggestions); engine and job errors never reach 3× usual
 * even for one step, so their job cycles raise nothing.
 */
export interface Rule {
  readonly floor: number
  readonly factor: number
  readonly spike: { readonly floor: number; readonly factor: number }
  /** Counted per step (log lines, OOM events), not a level (a gauge, a rate, a latency). */
  readonly perStep: boolean
}

export const RULES: Readonly<Record<string, Rule>> = {
  api_5xx: { floor: 50, factor: 3, spike: { floor: 100, factor: 4 }, perStep: true },
  api_p99: { floor: 1_500, factor: 2, spike: { floor: 3_000, factor: 3 }, perStep: false },
  engine_errors: { floor: 1_500, factor: 3, spike: { floor: 1_500, factor: 3 }, perStep: true },
  job_errors: { floor: 1_500, factor: 3, spike: { floor: 1_500, factor: 3 }, perStep: true },
  rpc_errors: { floor: 40, factor: 3, spike: { floor: 60, factor: 3 }, perStep: false },
  failed_job_pods: { floor: 8, factor: 2, spike: { floor: 10, factor: 2.5 }, perStep: false },
  oom_kills: { floor: 1, factor: 1, spike: { floor: 1, factor: 1 }, perStep: true },
  db_waiting: { floor: 5, factor: 3, spike: { floor: 10, factor: 3 }, perStep: false },
}

export const RECENT_STEPS = 3
/** Two hours before the recent steps; with less there is no baseline to compare to. */
export const MIN_BASELINE_STEPS = 24

/** Where a ruled signal stands: its recent level against its usual one. */
export interface Measure {
  readonly panel: Panel
  /** The panel's rule. */
  readonly rule: Rule
  /** Median of the recent steps. */
  readonly level: number
  /** The highest recent step, and when it started. */
  readonly peak: number
  readonly peakAt: Date
  /** 90th percentile of the steps before them. */
  readonly usual: number
  /** Start of the first recent step. */
  readonly since: Date
}

/** A measure that broke its rule. For a spike, `level` is its peak and `since` the peak's step. */
export interface Anomaly extends Measure {
  /** A spike is a finding about one step; a rise, about where the signal sits. */
  readonly shape: "rise" | "spike"
}

const quantile = (values: ReadonlyArray<number>, q: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(q * (sorted.length - 1))] ?? 0
}

/**
 * Every series of the panel summed per step, oldest first, keyed by the start of the step. A log bucket at `t`
 * counts `[t, t+step)`, so the last one is still filling; a Prometheus point at `t` already covers `(t-step, t]`.
 */
const completeTotals = (panel: Panel, stepSeconds: number, now: Date, source: PanelSpec["source"]): ReadonlyArray<readonly [number, number]> => {
  const shift = source === "prom" ? stepSeconds : 0
  const totals = new Map<number, number>()
  for (const series of panel.series) for (const [t, v] of series.points) totals.set(t - shift, (totals.get(t - shift) ?? 0) + v)
  return [...totals.entries()].filter(([t]) => t + stepSeconds <= now.getTime() / 1000).sort(([a], [b]) => a - b)
}

/** The panel's level against its usual one, or null when it has no rule, failed or has too little history. */
export const measure = (panel: Panel, stepSeconds: number, now: Date, source: PanelSpec["source"] = "logs"): Measure | null => {
  const rule = RULES[panel.id]
  if (rule === undefined || panel.error !== null) return null
  const points = completeTotals(panel, stepSeconds, now, source)
  if (points.length < MIN_BASELINE_STEPS + RECENT_STEPS) return null
  const recent = points.slice(-RECENT_STEPS)
  const level = quantile(recent.map(([, v]) => v), 0.5)
  const usual = quantile(points.slice(0, -RECENT_STEPS).map(([, v]) => v), 0.9)
  const [peakT, peak] = recent.reduce((a, b) => (b[1] > a[1] ? b : a))
  return { panel, rule, level, usual, peak, peakAt: new Date(peakT * 1000), since: new Date((recent[0]?.[0] ?? 0) * 1000) }
}

const isRise = (m: Measure): boolean => m.level >= m.rule.floor && m.level > m.rule.factor * m.usual

const isSpike = (m: Measure): boolean => m.peak >= m.rule.spike.floor && m.peak > m.rule.spike.factor * m.usual

/** The measure as an anomaly: a rise if it is one, else a spike (its level the peak, since the peak's step), else null. */
export const anomalyOf = (m: Measure): Anomaly | null => {
  if (isRise(m)) return { ...m, shape: "rise" }
  return isSpike(m) ? { ...m, level: m.peak, since: m.peakAt, shape: "spike" } : null
}

/** `measure` then `anomalyOf`, in one step (for tests and replays; the watcher keeps the measure to settle on). */
export const detect = (panel: Panel, stepSeconds: number, now: Date, source: PanelSpec["source"] = "logs"): Anomaly | null => {
  const m = measure(panel, stepSeconds, now, source)
  return m === null ? null : anomalyOf(m)
}

/** Within a cooldown, a rise gets a new finding only once it reaches this many times the last finding's level. */
export const WORSE_FACTOR = 3

/** What every finding about one signal shares, so a rise is deduped, cooled down and settled as one. */
export const watchFingerprint = (signal: string): string => `watch:${signal}`

/**
 * Back to normal since a finding was raised at a time when the signal was usually up to `usualThen`: under the
 * rule's floor, or within 1.5× that. Measured against the level then, not the moving baseline, which a long rise
 * drags up with it.
 */
export const backToUsual = (m: Measure, usualThen: number): boolean => m.level < m.rule.floor || m.level <= 1.5 * usualThen

// MARK: The finding

const round = (value: number) => (value >= 100 ? Math.round(value).toLocaleString("en-US") : String(Number(value.toPrecision(2))))

export const formatValue = (value: number, unit: Unit): string => {
  switch (unit) {
    case "ms":
      return value >= 1_000 ? `${round(value / 1_000)}s` : `${Math.round(value)}ms`
    case "per_s":
      return `${round(value)}/s`
    case "bytes":
      return `${round(value / 1e9)} GB`
    case "count":
      return round(value)
  }
}

export const clock = (date: Date) => `${date.toISOString().slice(11, 16)} UTC`

const span = (minutes: number): string =>
  minutes < 60 ? `${minutes} minutes` : minutes % 60 === 0 ? `${minutes / 60} hours` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`

/**
 * The anomaly as an alert Bridgetown raised itself: no Slack message, so the
 * channel is "Grafana" and the permalink is the dashboard over the window.
 */
export const findingOf = (anomaly: Anomaly, spec: PanelSpec, stepSeconds: number, deploys: ReadonlyArray<Deploy>, link: string): ParsedAlert => {
  const { panel, rule, level, usual, since, shape } = anomaly
  const per = rule.perStep ? ` per ${stepSeconds / 60} min` : ""
  const title = `${panel.title} ${shape === "spike" ? "spiked to" : "at"} ${formatValue(level, panel.unit)}${per}, usually up to ${formatValue(usual, panel.unit)}`
  const shipped = deploys.filter((d) => Date.parse(d.at) >= since.getTime() - 60 * 60_000)
  const summary = [
    `${shape === "spike" ? `At ${clock(since)}, ${panel.title} spiked for ${stepSeconds / 60} minutes to` : `Since ${clock(since)}, ${panel.title} has been`} ${usual > 0 ? `${round(level / usual)}× its usual level` : "above a usual level of zero"} (the 90th percentile of the ${span(WATCH_HOURS * 60 - (RECENT_STEPS * stepSeconds) / 60)} before).`,
    shipped.length === 0 ? "No deploy in the hour before." : `Deploys around it: ${shipped.map((d) => `${d.image} ${d.version} ${d.status} at ${clock(new Date(d.at))}`).join(", ")}.`,
    "Bridgetown saw this in Grafana; no Slack alert has fired for it.",
  ].join(" ")
  const query = spec.query(stepSeconds)
  const datasource = spec.source === "prom" ? "VictoriaMetrics (PromQL)" : "VictoriaLogs (LogsQL)"
  const seconds = String(Math.floor(since.getTime() / 1000))
  return {
    id: `watch:${panel.id}:${seconds}`,
    channelId: WATCH_CHANNEL.id,
    channelName: WATCH_CHANNEL.name,
    ts: seconds,
    title,
    summary,
    raw: [title, summary, `${datasource}, ${stepSeconds / 60}-minute steps: ${query}`, `Dashboard: ${link}`].join("\n"),
    source: "watch",
    fingerprint: watchFingerprint(panel.id),
    fields: { _tag: "watch", signal: panel.id, query, datasource: spec.source, level, usual, since: since.toISOString(), shape },
    mentionsMe: false,
    fromHuman: false,
  }
}
