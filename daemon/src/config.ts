import { homedir } from "node:os"
import { join } from "node:path"
import { Context } from "effect"
import { type Secrets, secretsFromEnv } from "./secrets.ts"

export const VERSION = "1.0.2" // x-release-please-version

export const GH_HOST = "nocturlab.ghe.com"
export const GHE_REPO = "Merkl/monorepo"

/**
 * Git over HTTPS with the `gh` token, for the daemon and every session it starts.
 * Launched by the app, nobody is there to approve an SSH agent prompt
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

export interface Env {
  /** The loopback port the API listens on; sessions are refused network calls to it. */
  readonly port: number
  /** Where the store lives, and the worktrees of a repo without `.shared/`. */
  readonly home: string
  readonly apiToken: string | undefined
  readonly slackToken: string | undefined
  readonly typesafeKey: string | undefined
  readonly forceDryRun: boolean
  readonly jevModel: string
  /** The `claude` CLI sessions run, over the default (`AgentLive`). */
  readonly claudePath: string | undefined
  /** Where that CLI keeps its conversations, as it reads it: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  readonly claudeConfigDir: string
  /** The `codex` CLI reviews run, over the one on the PATH. */
  readonly codexPath: string | undefined
}

/** The environment the daemon was launched with, for the services that need some of it. */
export class Environment extends Context.Service<Environment, Env>()("Environment") {}

/** The daemon's own settings from its environment and argv, read once at launch: the only place that reads them. */
export const readEnv = (env: NodeJS.ProcessEnv = process.env, secrets: Secrets = secretsFromEnv(env), argv: ReadonlyArray<string> = process.argv): Env => ({
  port: Number(env.BRIDGETOWN_PORT ?? 47621),
  home: env.BRIDGETOWN_HOME ?? join(homedir(), "Library", "Application Support", "Bridgetown"),
  apiToken: secrets.apiToken,
  slackToken: secrets.slackToken,
  typesafeKey: secrets.typesafeKey,
  forceDryRun: argv.includes("--dry-run") || env.BRIDGETOWN_DRY_RUN === "1",
  jevModel: env.JEV_MODEL ?? "jev-1.13.0",
  claudePath: env.BRIDGETOWN_CLAUDE_PATH,
  claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  codexPath: env.BRIDGETOWN_CODEX_PATH,
})
