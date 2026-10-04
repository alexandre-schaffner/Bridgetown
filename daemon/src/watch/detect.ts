import type { ParsedAlert } from "../domain/alert.ts"
import type { Deploy, Panel } from "../grafana/board.ts"
import { type PanelSpec, type Unit, WATCH_HOURS } from "../grafana/boards.ts"

/**
 * When a prod signal has risen: the median of its last three complete steps
 * (15 minutes) is at least `floor` and above `factor` × the 90th percentile of
 * the steps before them. A median needs two of the three steps up, so a single
 * burst never counts: on a normal day API 5xx sit near 3 per 5 minutes with
 * one-step bursts to 470, and engine and job errors swing 10–600 as jobs run.
 * Floors come from a day of real data (2026-10-03), where none of these fired.
 */
export interface Rule {
  readonly floor: number
  readonly factor: number
  /** Counted per step (log lines, OOM events), not a level (a gauge, a rate, a latency). */
  readonly perStep: boolean
}

export const RULES: Readonly<Record<string, Rule>> = {
  api_5xx: { floor: 50, factor: 3, perStep: true },
  api_p99: { floor: 1_500, factor: 2, perStep: false },
  engine_errors: { floor: 1_500, factor: 3, perStep: true },
  job_errors: { floor: 1_500, factor: 3, perStep: true },
  rpc_errors: { floor: 40, factor: 3, perStep: false },
  failed_job_pods: { floor: 8, factor: 2, perStep: false },
  oom_kills: { floor: 1, factor: 1, perStep: true },
  db_waiting: { floor: 5, factor: 3, perStep: false },
}

export const RECENT_STEPS = 3
/** Two hours before the recent steps; with less there is no baseline to compare to. */
export const MIN_BASELINE_STEPS = 24

export interface Anomaly {
  readonly panel: Panel
  /** Median of the recent steps. */
  readonly level: number
  /** 90th percentile of the steps before them. */
  readonly usual: number
  /** Start of the first recent step. */
  readonly since: Date
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

/** The panel's anomaly, or null when it has no rule, failed, has too little history or is within its usual range. */
export const detect = (panel: Panel, stepSeconds: number, now: Date, source: PanelSpec["source"] = "logs"): Anomaly | null => {
  const rule = RULES[panel.id]
  if (rule === undefined || panel.error !== null) return null
  const points = completeTotals(panel, stepSeconds, now, source)
  if (points.length < MIN_BASELINE_STEPS + RECENT_STEPS) return null
  const recent = points.slice(-RECENT_STEPS)
  const level = quantile(recent.map(([, v]) => v), 0.5)
  const usual = quantile(points.slice(0, -RECENT_STEPS).map(([, v]) => v), 0.9)
  if (level < rule.floor || level <= rule.factor * usual) return null
  return { panel, level, usual, since: new Date((recent[0]?.[0] ?? 0) * 1000) }
}

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

const clock = (date: Date) => `${date.toISOString().slice(11, 16)} UTC`

const span = (minutes: number): string =>
  minutes < 60 ? `${minutes} minutes` : minutes % 60 === 0 ? `${minutes / 60} hours` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`

/**
 * The anomaly as an alert Bridgetown raised itself: no Slack message, so the
 * channel is "Grafana" and the permalink is the dashboard over the window.
 */
export const findingOf = (anomaly: Anomaly, spec: PanelSpec, stepSeconds: number, deploys: ReadonlyArray<Deploy>, link: string): ParsedAlert => {
  const { panel, level, usual, since } = anomaly
  const rule = RULES[panel.id]
  const per = rule?.perStep === true ? ` per ${stepSeconds / 60} min` : ""
  const title = `${panel.title} at ${formatValue(level, panel.unit)}${per}, usually up to ${formatValue(usual, panel.unit)}`
  const shipped = deploys.filter((d) => Date.parse(d.at) >= since.getTime() - 60 * 60_000)
  const summary = [
    `Since ${clock(since)}, ${panel.title} has been ${usual > 0 ? `${round(level / usual)}× its usual level` : "above a usual level of zero"} (the 90th percentile of the ${span(WATCH_HOURS * 60 - (RECENT_STEPS * stepSeconds) / 60)} before).`,
    shipped.length === 0 ? "No deploy in the hour before." : `Deploys around it: ${shipped.map((d) => `${d.image} ${d.version} ${d.status} at ${clock(new Date(d.at))}`).join(", ")}.`,
    "Bridgetown saw this in Grafana; no Slack alert has fired for it.",
  ].join(" ")
  const query = spec.query(stepSeconds)
  const datasource = spec.source === "prom" ? "VictoriaMetrics (PromQL)" : "VictoriaLogs (LogsQL)"
  const seconds = String(Math.floor(since.getTime() / 1000))
  return {
    id: `watch:${panel.id}:${seconds}`,
    channelId: "grafana",
    channelName: "Grafana",
    ts: seconds,
    title,
    summary,
    raw: [title, summary, `${datasource}, ${stepSeconds / 60}-minute steps: ${query}`, `Dashboard: ${link}`].join("\n"),
    source: "watch",
    fingerprint: `watch:${panel.id}`,
    fields: { _tag: "watch", signal: panel.id, query, datasource: spec.source, level, usual, since: since.toISOString() },
    mentionsMe: false,
    fromHuman: false,
  }
}
