import { toMrkdwn } from "../slack/text.ts"
import { prNumber, revvLink } from "./pr.ts"

/** Slack user groups, as `packages/alerting/src/deployment.reviewers.ts` encodes them. */
const DEV_PRODUCT = "<!subteam^S0ATVUW9T7V|dev-product>"
const ENGINE_TEAM = "<!subteam^S0AU07798EA|engine-team>"
const INFRA_TEAM = "<!subteam^S0AV28YJPG8|infra-team>"
const RD_TEAM = "<!subteam^S0ATLPMJECF|rd-team>"

const PRODUCT_APPROVALS = { channelId: "C0ATZJNRU2J", channelName: "product-approvals" }
const GENERAL_APPROVALS = { channelId: "C0AT6P4E9B5", channelName: "general-approvals" }

/** Release tag prefix (`admin` in `admin-v0.6.0`) or deploy image → owning team. */
const TEAMS: Record<string, string> = {
  api: DEV_PRODUCT,
  app: DEV_PRODUCT,
  admin: DEV_PRODUCT,
  studio: DEV_PRODUCT,
  developer: DEV_PRODUCT,
  docs: DEV_PRODUCT,
  landing: DEV_PRODUCT,
  drip: DEV_PRODUCT,
  morpho: DEV_PRODUCT,
  plasma: DEV_PRODUCT,
  tac: DEV_PRODUCT,
  cryptobook: DEV_PRODUCT,
  engine: ENGINE_TEAM,
  "engine-go": ENGINE_TEAM,
  states: ENGINE_TEAM,
  "state-service": ENGINE_TEAM,
  authn: INFRA_TEAM,
  authz: INFRA_TEAM,
  "authz-service": INFRA_TEAM,
  "merkl-tree": INFRA_TEAM,
  "tree-service": INFRA_TEAM,
  "states-exporter": RD_TEAM,
  mcp: RD_TEAM,
}

export interface ReviewRoute {
  readonly channelId: string
  readonly channelName: string
  readonly mention: string | null
}

/** Product work goes to #product-approvals, everything else to #general-approvals with its team. */
export const reviewRoute = (component: string | null): ReviewRoute => {
  const key = (component ?? "").replace(/^merkl-?/, "") || (component === "merkl" ? "engine" : "")
  const team = TEAMS[key] ?? (component === "merkl" ? ENGINE_TEAM : null)
  const channel = team === DEV_PRODUCT ? PRODUCT_APPROVALS : GENERAL_APPROVALS
  return { ...channel, mention: team }
}

export interface ReviewRequest {
  readonly route: ReviewRoute
  readonly prUrl: string
  readonly prTitle: string
  readonly summary: string
  readonly alertTitle: string
  readonly alertPermalink: string | null
}

export const reviewRequestText = (request: ReviewRequest): string => {
  const number = prNumber(request.prUrl)
  const revv = revvLink(request.prUrl)
  const alert = request.alertPermalink === null ? request.alertTitle : `<${request.alertPermalink}|${request.alertTitle}>`
  return [
    `${request.route.mention === null ? "" : `${request.route.mention} `}amp <${request.prUrl}|${number === null ? request.prTitle : `#${number}`}> — ${request.prTitle}`,
    `Fixes ${alert}: ${toMrkdwn(request.summary)}`,
    ...(revv === null ? [] : [`Walkthrough in Revv: ${revv}`]),
  ].join("\n")
}
