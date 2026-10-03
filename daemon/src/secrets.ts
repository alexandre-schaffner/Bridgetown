import { Schema } from "effect"

/**
 * The daemon's credentials. With `BRIDGETOWN_SECRETS=stdin` the app writes them
 * as one JSON line on stdin; for development they still come from these env vars.
 * Either way they are deleted from `process.env` before anything is spawned.
 */
export const SECRET_ENV_KEYS = ["BRIDGETOWN_API_TOKEN", "SLACK_USER_TOKEN", "TYPESAFE_API_KEY"] as const

export interface Secrets {
  readonly apiToken: string | undefined
  readonly slackToken: string | undefined
  readonly typesafeKey: string | undefined
}

const nonEmpty = (value: string | null | undefined): string | undefined =>
  value === null || value === undefined || value.trim() === "" ? undefined : value

export const secretsFromEnv = (env: Record<string, string | undefined>): Secrets => ({
  apiToken: nonEmpty(env.BRIDGETOWN_API_TOKEN),
  slackToken: nonEmpty(env.SLACK_USER_TOKEN),
  typesafeKey: nonEmpty(env.TYPESAFE_API_KEY),
})

const SecretsLine = Schema.Struct({
  apiToken: Schema.String,
  slackUserToken: Schema.optional(Schema.NullOr(Schema.String)),
  typesafeApiKey: Schema.optional(Schema.NullOr(Schema.String)),
})

/** The stdin launch line, or `undefined` when it is not JSON or carries no API token. */
export const decodeSecretsLine = (line: string): Secrets | undefined => {
  const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(SecretsLine))(line)
  if (decoded._tag === "Failure") return undefined
  const apiToken = nonEmpty(decoded.value.apiToken)
  if (apiToken === undefined) return undefined
  return { apiToken, slackToken: nonEmpty(decoded.value.slackUserToken), typesafeKey: nonEmpty(decoded.value.typesafeApiKey) }
}

export interface StdinSecrets {
  /** The first line, without its newline; `undefined` when stdin closed before sending anything. */
  readonly line: string | undefined
  /** Settles when stdin reaches EOF: the app quit or crashed. */
  readonly closed: Promise<void>
}

/** Reads the first line, then keeps draining (and discarding) the pipe so its EOF is noticed. */
export const readFirstLine = async (stream: ReadableStream<Uint8Array>): Promise<StdinSecrets> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      const rest = buffered.replace(/\r$/, "")
      return { line: rest === "" ? undefined : rest, closed: Promise.resolve() }
    }
    buffered += decoder.decode(chunk.value, { stream: true })
    const newline = buffered.indexOf("\n")
    if (newline === -1) continue
    const line = buffered.slice(0, newline).replace(/\r$/, "")
    const drain = async () => {
      while (!(await reader.read()).done) {}
    }
    return { line, closed: drain().catch(() => undefined) }
  }
}

/** Prefixes of variables a child process must never inherit: the daemon's own config and every Slack/TypeSafe credential. */
const STRIPPED_PREFIXES = ["BRIDGETOWN_", "SLACK_", "TYPESAFE_"]

/**
 * The environment for anything the daemon spawns: agent sessions, `git`, `gh`,
 * `bun install`. `ANTHROPIC_API_KEY` stays: the Claude CLI authenticates with it
 * when the user is not logged in with OAuth, and it is the agent's own credential.
 */
export const childEnv = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    out[key] = value
  }
  return out
}

/** Removes the credentials and the launch-mode flag from this process, so nothing reads them later by accident. */
export const scrubProcessEnv = (env: Record<string, string | undefined> = process.env): void => {
  for (const key of [...SECRET_ENV_KEYS, "BRIDGETOWN_SECRETS"]) delete env[key]
}
