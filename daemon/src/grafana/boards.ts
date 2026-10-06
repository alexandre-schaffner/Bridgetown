import type { Alert } from "../domain/alert.ts"
import { alertKind } from "../triage/kind.ts"
import { LOGS_DATASOURCE } from "./client.ts"
import { ERROR_LEVELS, regexLiteral } from "./logsql.ts"

/**
 * Panel titles leave out the route, image or chain: the board's title names it.
 *
 * Which Grafana panels to show: the overview's two boards, and for each alert a
 * small board picked from what it is about (an API route, a release image, a
 * chain). Queries are ours, from the dashboards in docs/OBSERVABILITY.md; the
 * only things taken from an alert are a route, an image name and a chain id,
 * each matched against a strict pattern before it goes anywhere near a query.
 */

export const GRAFANA_BASE_URL = "https://grafana.internal.merkl.xyz"

export type Unit = "count" | "ms" | "per_s" | "bytes"

export interface PanelSpec {
  readonly id: string
  readonly title: string
  readonly unit: Unit
  readonly source: "prom" | "logs"
  /** The query for a step: counts per step and `increase` windows follow it. */
  readonly query: (stepSeconds: number) => string
  /** The dashboard this panel comes from, opened by "Open in Grafana". */
  readonly dashboard: string
  /** The label naming each series; absent for a single series. */
  readonly seriesLabel?: string
}

export interface BoardSpec {
  /** Cache key: the same spec over the same window gives the same board. */
  readonly key: string
  readonly title: string
  readonly from: Date
  readonly to: Date
  readonly stepSeconds: number
  /** When the alert fired, drawn as a rule on every panel. */
  readonly marker: Date | null
  readonly panels: ReadonlyArray<PanelSpec>
  /** Deploys listed and drawn on the panels: of this image only, when set. */
  readonly deployImage: string | null
  readonly deploysFrom: Date
}

export type OverviewView = "incidents" | "infra" | "database"
export const OVERVIEW_VIEWS: ReadonlyArray<OverviewView> = ["incidents", "infra", "database"]

export const HOUR = 3_600_000

/** The overview shows what's happening now: the last hour, deploys included. */
export const OVERVIEW_HOURS = 1

/** About 48 points across the window, in whole minutes. */
export const stepFor = (from: Date, to: Date): number => Math.max(60, Math.ceil((to.getTime() - from.getTime()) / 1000 / 48 / 60) * 60)

// MARK: Panels

const api5xx: PanelSpec = {
  id: "api_5xx",
  title: "API 5xx",
  unit: "count",
  source: "logs",
  query: () => `k8s.container.name:="envoy" envoy.response_code:>=500 | stats count() n`,
  dashboard: "pihjbxm",
}

const apiP99: PanelSpec = {
  id: "api_p99",
  title: "API p99 latency",
  unit: "ms",
  source: "logs",
  query: () => `k8s.container.name:="envoy" | stats quantile(0.99, envoy.duration) p99`,
  dashboard: "pihjbxm",
}

const engineErrors = (chain: string | null): PanelSpec => ({
  id: chain === null ? "engine_errors" : `engine_errors_${chain}`,
  title: "Engine errors",
  unit: "count",
  source: "logs",
  query: () =>
    `(merkl.job:~"merkl-(compute|precompute)-.*" OR service:engine)${chain === null ? "" : ` merkl.chain-id:="${chain}"`} severity_number:>16 | stats count() n`,
  dashboard: "engine-errors",
})

const jobErrors = (chain: string | null): PanelSpec => ({
  id: chain === null ? "job_errors" : `job_errors_${chain}`,
  title: "Job errors",
  unit: "count",
  source: "logs",
  query: () => `_stream:{merkl.job!=""}${chain === null ? "" : ` merkl.chain-id:="${chain}"`} ${ERROR_LEVELS} | stats count() n`,
  dashboard: "lej5qzh",
})

const rpcErrors = (chain: string | null): PanelSpec => ({
  id: chain === null ? "rpc_errors" : `rpc_errors_${chain}`,
  title: "RPC errors",
  unit: "per_s",
  source: "prom",
  query: () => `sum(rate(erpc_upstream_request_errors_total${chain === null ? "" : `{network="evm:${chain}"}`}[5m]))`,
  dashboard: "lehmvpt",
})

const headLag = (chain: string): PanelSpec => ({
  id: `head_lag_${chain}`,
  title: "Block head lag",
  unit: "count",
  source: "prom",
  query: () => `max(erpc_upstream_block_head_lag{network="evm:${chain}"})`,
  dashboard: "lehmvpt",
})

const failedJobPods: PanelSpec = {
  id: "failed_job_pods",
  title: "Failed job pods",
  unit: "count",
  source: "prom",
  query: () => `sum(k8s_job_failed_pods)`,
  dashboard: "le5hf58",
}

const oomKills: PanelSpec = {
  id: "oom_kills",
  title: "OOM kills",
  unit: "count",
  source: "prom",
  query: (step) => `sum(increase(container_oom_events_total[${step}s]))`,
  dashboard: "lemshps",
}

const dbWaiting: PanelSpec = {
  id: "db_waiting",
  title: "DB waits",
  unit: "count",
  source: "prom",
  query: () => `sum(cnpg_backends_waiting_total)`,
  dashboard: "lexpwjz",
}

/** Prod Postgres: the CNPG cluster behind the API and jobs, not Argo's own. Any pod, so a failover keeps the series. */
const PROD_DB = `service_name="cluster-timescaledb"`

const dbConnections: PanelSpec = {
  id: "db_connections",
  title: "Connections",
  unit: "count",
  source: "prom",
  query: () => `sum by (state) (cnpg_backends_total{${PROD_DB}})`,
  dashboard: "lexpwjz",
  seriesLabel: "state",
}

const dbLockWaits: PanelSpec = {
  id: "db_lock_waits",
  title: "Waiting on locks",
  unit: "count",
  source: "prom",
  query: () => `sum(cnpg_backends_waiting_total{${PROD_DB}})`,
  dashboard: "lexpwjz",
}

const dbLongestTx: PanelSpec = {
  id: "db_longest_tx",
  title: "Longest transaction",
  unit: "ms",
  source: "prom",
  query: () => `max(cnpg_backends_max_tx_duration_seconds{${PROD_DB}}) * 1000`,
  dashboard: "lexpwjz",
}

const dbReplicationLag: PanelSpec = {
  id: "db_replication_lag",
  title: "Replication lag",
  unit: "ms",
  source: "prom",
  query: () => `max(cnpg_pg_replication_lag{${PROD_DB}}) * 1000`,
  dashboard: "lexpwjz",
}

const routeFilter = (route: string) => `envoy.path:~"^${regexLiteral(route)}"`

const route5xx = (route: string): PanelSpec => ({
  id: `route_5xx_${route}`,
  title: "Route 5xx",
  unit: "count",
  source: "logs",
  query: () => `k8s.container.name:="envoy" ${routeFilter(route)} envoy.response_code:>=500 | stats count() n`,
  dashboard: "piv89bk",
})

const routeP99 = (route: string): PanelSpec => ({
  id: `route_p99_${route}`,
  title: "Route p99 latency",
  unit: "ms",
  source: "logs",
  query: () => `k8s.container.name:="envoy" ${routeFilter(route)} | stats quantile(0.99, envoy.duration) p99`,
  dashboard: "piv89bk",
})

/** The k8s deployment of a release image: `merkl-api` runs as `api`, `merkl-admin` as itself. */
const deploymentMatcher = (image: string) => `k8s_deployment_name=~"(merkl-)?${regexLiteral(image.replace(/^merkl-/, ""))}"`

const podsByVersion = (image: string): PanelSpec => ({
  id: `pods_${image}`,
  title: "Pods by version",
  unit: "count",
  source: "prom",
  query: () => `count by (container_image_tag) (k8s_pod_cpu_usage{${deploymentMatcher(image)}})`,
  dashboard: "lemshps",
  seriesLabel: "container_image_tag",
})

const imageMemory = (image: string): PanelSpec => ({
  id: `memory_${image}`,
  title: "Memory",
  unit: "bytes",
  source: "prom",
  query: () => `sum(k8s_pod_memory_usage_bytes{${deploymentMatcher(image)}})`,
  dashboard: "lemshps",
})

const imageCpu = (image: string): PanelSpec => ({
  id: `cpu_${image}`,
  title: "CPU (cores)",
  unit: "count",
  source: "prom",
  query: () => `sum(k8s_pod_cpu_usage{${deploymentMatcher(image)}})`,
  dashboard: "lemshps",
})

// MARK: What an alert is about

/** "/v4/opportunities" from "api.merkl.xyz/v4/opportunities 500s" or an uptime target. */
export const routeOf = (alert: Alert): string | null => {
  const text = alert.fields._tag === "uptime" ? `${alert.fields.target} ${alert.title}` : alert.title
  const match = /(\/v\d+\/[A-Za-z0-9_\-/.]{1,80})/.exec(text)?.[1]?.replace(/[/.]+$/, "")
  return match !== undefined && /^\/v\d+\/[A-Za-z0-9_\-/.]+$/.test(match) ? match : null
}

/** A release alert's image, e.g. "merkl-api". */
export const imageOf = (alert: Alert): string | null =>
  alert.fields._tag === "release" && /^[a-z0-9][a-z0-9-]{0,40}$/.test(alert.fields.image) ? alert.fields.image : null

const CHAINS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bethereum\b|\bmainnet\b/i, "1"],
  [/\barbitrum\b/i, "42161"],
  [/\bbase\b/i, "8453"],
  [/\boptimism\b/i, "10"],
  [/\bpolygon\b/i, "137"],
  [/\bbsc\b|\bbnb\b/i, "56"],
  [/\bavalanche\b/i, "43114"],
  [/\bgnosis\b/i, "100"],
  [/\blinea\b/i, "59144"],
  [/\bscroll\b/i, "534352"],
  [/\bsonic\b/i, "146"],
  [/\bunichain\b/i, "130"],
  [/\bzksync\b/i, "324"],
  [/\bmantle\b/i, "5000"],
  [/\bblast\b/i, "81457"],
  [/\bcelo\b/i, "42220"],
]

/** A chain id: "chainId 8453", "chain: 8453", or a chain named in the title or summary. */
export const chainOf = (alert: Alert): string | null => {
  const text = `${alert.title} ${alert.summary}`
  const explicit = /\bchain(?:[ _-]?id)?\s*[:#=]?\s*(\d{1,10})\b/i.exec(text)?.[1]
  if (explicit !== undefined) return explicit
  return CHAINS.find(([pattern]) => pattern.test(text))?.[1] ?? null
}

// MARK: Boards

export const overviewPanels = (view: OverviewView): ReadonlyArray<PanelSpec> => {
  switch (view) {
    case "incidents":
      return [api5xx, apiP99, engineErrors(null), jobErrors(null)]
    case "infra":
      return [rpcErrors(null), failedJobPods, oomKills, dbWaiting]
    case "database":
      return [dbConnections, dbLockWaits, dbLongestTx, dbReplicationLag]
  }
}

const VIEW_TITLES: Readonly<Record<OverviewView, string>> = { incidents: "Incidents", infra: "Infra", database: "Database" }

export const overviewBoard = (view: OverviewView, now: Date): BoardSpec => {
  const from = new Date(now.getTime() - OVERVIEW_HOURS * HOUR)
  const panels = overviewPanels(view)
  return {
    key: `overview:${view}`,
    title: VIEW_TITLES[view],
    from,
    to: now,
    stepSeconds: stepFor(from, now),
    marker: null,
    panels,
    deployImage: null,
    deploysFrom: from,
  }
}

/**
 * The board for one alert, 6 hours either side of it (up to now), or null when
 * nothing in Grafana tracks what it's about (a DM, a question in a thread).
 */
export const alertBoard = (alert: Alert, now: Date): BoardSpec | null => {
  const at = new Date(alert.receivedAt)
  if (Number.isNaN(at.getTime())) return null
  const route = routeOf(alert)
  const image = imageOf(alert)
  const chain = chainOf(alert)
  const kind = alertKind(alert)

  const pick = (): { readonly title: string; readonly panels: ReadonlyArray<PanelSpec> } | null => {
    if (route !== null) return { title: `API · ${route}`, panels: [route5xx(route), routeP99(route), api5xx, apiP99] }
    if (image !== null) return { title: image, panels: [podsByVersion(image), imageMemory(image), imageCpu(image), api5xx] }
    if (alert.fields._tag === "inbox") return null
    if (alert.fields._tag === "watch") {
      // The overview board the signal is on, with the signal first.
      const signal = alert.fields.signal
      const view = OVERVIEW_VIEWS.find((v) => overviewPanels(v).some((p) => p.id === signal)) ?? "incidents"
      const panels = overviewPanels(view)
      return { title: VIEW_TITLES[view], panels: [...panels.filter((p) => p.id === signal), ...panels.filter((p) => p.id !== signal)] }
    }
    switch (kind) {
      case "onchain_or_keeper":
        return chain !== null
          ? { title: `Chain ${chain}`, panels: [rpcErrors(chain), headLag(chain), jobErrors(chain), engineErrors(chain)] }
          : { title: "Onchain", panels: [rpcErrors(null), jobErrors(null), engineErrors(null), failedJobPods] }
      case "infra_or_cert":
        return { title: "Infra", panels: [failedJobPods, oomKills, dbWaiting, rpcErrors(null)] }
      case "build_failure":
      case "deploy_failure":
        return { title: "Deploys", panels: [failedJobPods, api5xx, apiP99, oomKills] }
      case "uptime_incident":
      case "runtime_error":
      case "informational":
        return { title: "API and jobs", panels: [api5xx, apiP99, engineErrors(chain), jobErrors(chain)] }
    }
  }

  const picked = pick()
  if (picked === null) return null
  const from = new Date(at.getTime() - 6 * HOUR)
  const to = new Date(Math.min(now.getTime(), at.getTime() + 6 * HOUR))
  return {
    key: `alert:${alert.id}`,
    title: picked.title,
    from,
    to,
    stepSeconds: stepFor(from, to),
    marker: at,
    panels: picked.panels,
    deployImage: image,
    deploysFrom: image === null ? from : new Date(at.getTime() - 72 * HOUR),
  }
}

/** "Open in Grafana" for a panel's dashboard over the board's window. Opened in the browser, never fetched. */
export const dashboardLink = (dashboard: string, from: Date, to: Date): string =>
  `${GRAFANA_BASE_URL}/d/${dashboard}?from=${from.getTime()}&to=${to.getTime()}`

/** "Open in Grafana" for a LogsQL query: Explore on VictoriaLogs over the window. Opened in the browser, never fetched. */
export const exploreLogsLink = (query: string, from: Date, to: Date): string => {
  const datasource = { type: "victoriametrics-logs-datasource", uid: LOGS_DATASOURCE }
  const panes = { a: { datasource: datasource.uid, queries: [{ refId: "A", expr: query, datasource }], range: { from: String(from.getTime()), to: String(to.getTime()) } } }
  return `${GRAFANA_BASE_URL}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`
}
