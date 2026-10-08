import { Schema } from "effect"

/**
 * The daemon's credentials. The app writes them on the daemon's stdin as one JSON line
 * (launch.ts); scripts run by hand (`scripts/replay.ts`) read them from the environment.
 * Nothing the daemon spawns inherits them either way (`childEnv`).
 */
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
export const decodeSecretsLine = (line: string): (Secrets & { readonly apiToken: string }) | undefined => {
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

/** Trusted utility processes do not need daemon or inference-provider credentials. */
const CHILD_VARIABLES = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME"])
export const childEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && CHILD_VARIABLES.has(entry[0])))

/** Authentication is only passed to the trusted inference client, never generated commands. */
export const providerEnv = (env: Record<string, string | undefined>): Record<string, string> => ({
  ...childEnv(env),
  ...Object.fromEntries(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"].flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]])),
})
