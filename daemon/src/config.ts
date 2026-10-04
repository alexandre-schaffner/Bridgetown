import { homedir } from "node:os"
import { join } from "node:path"
import { type Channel, FINDING_THRESHOLDS, type Settings } from "./domain/model.ts"
import { type Secrets, secretsFromEnv } from "./secrets.ts"

export const VERSION = "0.1.0"

export const GH_HOST = "nocturlab.ghe.com"
export const GHE_REPO = "Merkl/monorepo"

/**
 * Git over HTTPS with the `gh` token, for the daemon and every session it starts.
 * Launched from the menu bar, nobody is there to approve an SSH agent prompt
 * (1Password asks per process), so `nocturlab@nocturlab.ghe.com:` remotes are
 * rewritten for our processes only; the user's git config is untouched.
 */
export const gitOverHttpsEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const base = Number(env.GIT_CONFIG_COUNT ?? 0)
  const pairs: ReadonlyArray<readonly [string, string]> = [
    [`url.https://${GH_HOST}/.insteadOf`, `nocturlab@${GH_HOST}:`],
    [`url.https://${GH_HOST}/.insteadOf`, `ssh://nocturlab@${GH_HOST}/`],
    [`credential.https://${GH_HOST}.helper`, "!gh auth git-credential"],
  ]
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(base + pairs.length), GIT_TERMINAL_PROMPT: "0" }
  pairs.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${base + i}`] = key
    out[`GIT_CONFIG_VALUE_${base + i}`] = value
  })
  return out
}

export const appSupportDir = (): string =>
  process.env.BRIDGETOWN_HOME ?? join(homedir(), "Library", "Application Support", "Bridgetown")

export interface Env {
  readonly port: number
  readonly apiToken: string | undefined
  readonly slackToken: string | undefined
  readonly typesafeKey: string | undefined
  readonly forceDryRun: boolean
  readonly jevModel: string
}

/** The loopback port the API listens on; sessions are refused network calls to it. */
export const daemonPort = (): number => Number(process.env.BRIDGETOWN_PORT ?? 47621)

export const readEnv = (secrets: Secrets = secretsFromEnv(process.env), argv: ReadonlyArray<string> = process.argv): Env => ({
  port: daemonPort(),
  apiToken: secrets.apiToken,
  slackToken: secrets.slackToken,
  typesafeKey: secrets.typesafeKey,
  forceDryRun: argv.includes("--dry-run") || process.env.BRIDGETOWN_DRY_RUN === "1",
  jevModel: process.env.JEV_MODEL ?? "jev-1.13.0",
})

const channel = (id: string, name: string, enabled: boolean): Channel => ({ id, name, enabled })

export const DEFAULT_CHANNELS: ReadonlyArray<Channel> = [
  channel("C0AUKD42N3U", "alert-releases", true),
  channel("C0B001L8UQ1", "alert-uptime", true),
  channel("C0AUK4AUER0", "alert-engine", true),
  channel("C0BL3M3CGUR", "alert-infra", true),
  channel("C0B7KBYGA11", "alert-exporter", true),
  channel("C0BUA3C9Y93", "alert-dev", true),
  channel("C0AUB8LL9MZ", "alert-product", true),
  channel("C0AUB8NCSMR", "alert-product-report", true),
  channel("C0AUCLN8LLB", "alert-missing-prices", true),
  channel("C0AUXV18A7K", "alert-invalid-campaign", true),
  channel("C0B1GEVBBR6", "alert-creators", true),
  channel("C0B0Z6ZH3JM", "alert-dumper", true),
  channel("C0BEBUU5RTQ", "alert-managed-campaigns", true),
  channel("C0C51MRUBMJ", "alert-security", true),
  channel("C0BBTKZLF4H", "alert-autoclaim", true),
  channel("C0BDVR6817G", "alert-unclaimed-rewards", true),
  channel("C0B9CT54W4A", "alert-token-whitelist", true),
  channel("C0BKM3NH6TB", "alert_campaign_events", true),
  channel("C0ATB2GRB70", "general-dungeon-keeper", true),
]

export const DEFAULT_SETTINGS: Settings = {
  channels: DEFAULT_CHANNELS,
  thresholds: {
    autoActionable: 0.8,
    autoResolvable: 0.75,
    autoHumanOnItMax: 0.3,
    suggestActionable: 0.5,
    suggestResolvable: 0.4,
    ...FINDING_THRESHOLDS,
  },
  autoStart: true,
  inbox: true,
  maxConcurrent: 2,
  dryRun: true,
  adversarialReview: true,
  watchProd: true,
  pollSeconds: 30,
  monorepoPath: join(homedir(), "Projects", "merkl", "monorepo"),
  deploymentRepoPath: join(homedir(), "Projects", "merkl", "apps-deployment"),
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
}
