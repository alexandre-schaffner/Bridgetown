import type { SlackMessage } from "../../src/slack/client.ts"

/**
 * Shaped like the Merkl Jackson tracker output (`packages/alerting/src/deployment.slack.ts`):
 * a fallback `text`, then one `container` block with a two-column `fields` grid and a context footer.
 */
const tracker = (
  image: string,
  version: string,
  actor: string | null,
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
  footer: string,
): SlackMessage => {
  const fields: Array<{ type: string; text: string }> = []
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    fields.push({ type: "mrkdwn", text: left[i] ?? " " })
    fields.push({ type: "mrkdwn", text: right[i] ?? " " })
  }
  return {
    ts: "1790000000.000100",
    bot_id: "B0AU1BP0690",
    text: `Deployment ${image} ${version}`,
    blocks: [
      {
        type: "container",
        has_header_divider: true,
        title: { type: "plain_text", text: image },
        ...(actor === null ? {} : { subtitle: { type: "plain_text", text: `by ${actor}` } }),
        child_blocks: [
          { type: "section", fields },
          { type: "context", elements: [{ type: "mrkdwn", text: footer }] },
        ],
      },
    ],
  }
}

const RUN = (id: string) => `<https://nocturlab.ghe.com/Merkl/monorepo/actions/runs/${id}|Run>`

export const adminBuildFailed: SlackMessage = {
  ...tracker(
    "merkl-admin",
    "v0.6.0",
    "alex",
    [
      ":large_green_circle:  *Approval*\nApproved by hugo\nat 2026-10-02 : 11:25:05",
      `:red_circle:  *Build*\nBuild failed  ·  _1 attempt failed_\n${RUN("291250187")}`,
    ],
    [],
    "*`v0.6.0`*   ·   2026-10-02 : 11:23:26   ·   <https://nocturlab.ghe.com/Merkl/monorepo/releases/tag/admin-v0.6.0|Release notes>   ·   took 2m 27s",
  ),
  ts: "1790933006.123400",
  reply_count: 2,
}

export const exporterBuildFailed: SlackMessage = {
  ...tracker(
    "merkl-states-exporter",
    "v0.1.0",
    "thibaudb",
    [
      ":large_green_circle:  *Approval*\nApproved by nileco\nat 2026-10-02 : 10:53:25",
      `:red_circle:  *Build*\nBuild failed  ·  _2 attempts failed_\n${RUN("291033812")}`,
    ],
    [],
    "*`v0.1.0`*   ·   2026-10-02 : 10:14:33   ·   <https://nocturlab.ghe.com/Merkl/monorepo/releases/tag/states-exporter-v0.1.0|Release notes>   ·   took 40m 8s",
  ),
  ts: "1790928873.000200",
}

export const apiDeployed: SlackMessage = {
  ...tracker(
    "merkl-api",
    "v1.35.9",
    "picodes",
    [`:large_green_circle:  *Build*\nImage built · _3m 55s_\n${RUN("289536507")}`],
    [
      ":large_green_circle:  *Front Staging*\nDeployed · _7m 30s_\n<https://kargo.internal.merkl.xyz/project/merkl-kargo/promotion/merkl-api-front-staging.01m3|Kargo>",
      ":large_green_circle:  *Engine*\nDeployed · _1m 52s_\n<https://kargo.internal.merkl.xyz/project/merkl-kargo/promotion/etl-engine.01m3|Kargo>",
      ":large_green_circle:  *Front Production*\nDeployed · _8m 31s_\n<https://kargo.internal.merkl.xyz/project/merkl-kargo/promotion/merkl-api-front-production.01m3|Kargo>",
    ],
    "*`v1.35.9`*   ·   2026-10-02 : 09:57:53   ·   took 20m 26s",
  ),
  ts: "1790927873.000300",
}

export const engineWaitingApproval: SlackMessage = {
  ...tracker(
    "merkl",
    "v1.62.33",
    "vincent",
    [`:large_yellow_circle:  *Approval*\nWaiting for approval\n<!subteam^S0AU07798EA|@engine-team>\n${RUN("283768252")}`],
    [],
    "*`v1.62.33`*   ·   2026-09-29 : 20:12:46   ·   <https://nocturlab.ghe.com/Merkl/monorepo/releases/tag/engine-v1.62.33|Release notes>",
  ),
  ts: "1790705566.000400",
}

export const productionDeployFailed: SlackMessage = {
  ...tracker(
    "merkl-api",
    "v1.36.0",
    "picodes",
    [
      ":large_green_circle:  *Approval*\nApproved by hugo\nat 2026-10-03 : 09:00:00",
      `:large_green_circle:  *Build*\nImage built · _3m 50s_\n${RUN("292000001")}`,
    ],
    [
      ":large_green_circle:  *Front Staging*\nDeployed · _7m 10s_",
      ":red_circle:  *Production*\n↳ :large_green_circle: *API* — Deployed · _8m_\n↳ :red_circle: *ETL* — Deploy failed  ·  _1 attempt failed_\n<https://argocd.internal.merkl.xyz/applications/etl|ArgoCD>  ·  <https://kargo.internal.merkl.xyz/x|Kargo>",
    ],
    "*`v1.36.0`*   ·   2026-10-03 : 08:55:00   ·   took 22m",
  ),
  ts: "1791010000.000500",
}

export const failurePing: SlackMessage = {
  ts: "1790933010.000600",
  bot_id: "B0AU1BP0690",
  thread_ts: "1790933006.123400",
  text: ":rotating_light: Build failed, <@U07ALEX> please take a look.",
}

export const uptimeIncident: SlackMessage = {
  ts: "1790917248.000700",
  bot_id: "B0UPTIME",
  text: ":red_circle: *Incident started on API <http://api.merkl.xyz/v4/roots/delay*|api.merkl.xyz/v4/roots/delay*>",
}

export const uptimeResolved: SlackMessage = {
  ts: "1790775157.000800",
  bot_id: "B0UPTIME",
  text: ":large_green_circle: *Incident resolved on <http://rewards.plasma.to|rewards.plasma.to>*",
}

export const sslExpiry: SlackMessage = {
  ts: "1790809222.000900",
  bot_id: "B0UPTIME",
  text: "SSL certificate for <http://merkl.xyz|merkl.xyz> will expire in 7 days.",
}

export const degradedEnded: SlackMessage = {
  ts: "1790774511.001000",
  bot_id: "B0UPTIME",
  text: "Notification: Degraded performance for <http://api.merkl.xyz|api.merkl.xyz> has ended.",
}

export const stellarTreeRoot: SlackMessage = {
  ts: "1790863390.001100",
  bot_id: "B0AU1BP0690",
  text: ' Merkl Computation Run on Stellar\n:x: failed to update tree root on chain because: Error: Transaction failed on-chain: {"status":"FAILED","txHash":"d94107d987f786387ee6a2787c1db9979cb50c128f26bfd5405268f327892fa5","latestLedger":64712400}\n4 · 2026-10-01 : 12:03:10',
}

export const prismaCancelled: SlackMessage = {
  ts: "1789399583.001200",
  bot_id: "B0AU1BP0690",
  text: "Campaign with job index 0\n:x: cancel task with index 0\n*:skull: run is cancelled because of prisma error*\nTypeError [ERR_BODY_ALREADY_USED]: Body is disturbed or locked\n143 · 2026-09-14 : 16:46:36",
}

export const humanMessage: SlackMessage = {
  ts: "1790933700.001300",
  user: "U07ALEX",
  text: "this could be automated",
}

export const grafanaFiring: SlackMessage = {
  ts: "1790932620.336059",
  bot_id: "B0AU1BP0690",
  attachments: [
    {
      text: "<!subteam^S0AV28YJPG8>\n[FIRING:1] eRPC P95 95% Confidence Interval Infra Monitoring (evm:9745 plasma-mainnet.g.alchemy.com-1)\n**Firing**\nValue: D=0.0986252849226895, E=1",
    },
  ],
}

/** Exactly as `conversations.history` returns it: pretext, title and text are separate attachment fields. */
export const grafanaResolved: SlackMessage = {
  ts: "1790932920.303069",
  bot_id: "B0AU1BP0690",
  text: "",
  attachments: [
    {
      id: 1,
      color: "36a64f",
      fallback: "[RESOLVED] eRPC P95 95% Confidence Interval Infra Monitoring (evm:9745 plasma-mainnet.g.alchemy.com-1)",
      text: "**Resolved**\n\nValue: D=0, E=0\nLabels:\n - alertname = eRPC P95 95% Confidence Interval",
      pretext: "<!subteam^S0AV28YJPG8>",
      title: "[RESOLVED] eRPC P95 95% Confidence Interval Infra Monitoring (evm:9745 plasma-mainnet.g.alchemy.com-1)",
      footer: "Grafana v13.1.1",
    },
  ],
}

export const missingPriceWithUnfurl: SlackMessage = {
  ts: "1790915000.000100",
  bot_id: "B0AU1BP0690",
  text: "Stale price for Boardwalk (BWLK) <https://etherscan.io/address/0xF9a352b7C7B62a852e5C8A64A455246Dd9596461> — 60h old. Campaign Id: 7772424586270261909.",
  attachments: [
    { from_url: "https://etherscan.io/address/0xF9a352b7C7B62a852e5C8A64A455246Dd9596461", title: "Boardwalk: BWLK Token | Etherscan", text: "Contract: Verified | Token Rep: Neutral" },
  ],
}

export const exporterFinished: SlackMessage = {
  ts: "1790883104.000001",
  bot_id: "B0AU1BP0690",
  text: ":white_check_mark: *states-exporter* run finished\nduration: 1h16m39.939s\nversion: `172d2051`",
}

export const exporterSkipped: SlackMessage = {
  ts: "1790928197.000001",
  bot_id: "B0AU1BP0690",
  text: ":warning: *state_descriptions_latest*: skipped 4/1236 indexings on chain 8453 — job still green, 1232 rows committed",
}
