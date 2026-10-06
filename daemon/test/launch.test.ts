import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { readLaunch } from "../src/launch.ts"
import { scratchDir } from "./fixtures/tmp.ts"

const scratch = scratchDir("bt-launch-")
const lineOf = (secrets: object) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(secrets)}\n`))
      controller.close()
    },
  })

/** The daemon from source with `env` and nothing but EOF on stdin: what it prints, how it exits, and whether it got as far as its store. Port 1 can't be bound, so it never takes a real one. */
const daemon = (env: Record<string, string>) => {
  const home = join(scratch, crypto.randomUUID())
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BRIDGETOWN_|SLACK_|TYPESAFE_)/.test(key)))
  const result = Bun.spawnSync(["bun", join(import.meta.dir, "../src/main.ts")], {
    stdin: "ignore",
    env: { ...inherited, BRIDGETOWN_HOME: home, BRIDGETOWN_PORT: "1", ...env },
  })
  return { code: result.exitCode, err: result.stderr.toString(), touchedStore: existsSync(home) }
}

describe("the daemon's launch", () => {
  const saved = { BRIDGETOWN_SECRETS: process.env.BRIDGETOWN_SECRETS, SLACK_USER_TOKEN: process.env.SLACK_USER_TOKEN }
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test("its secrets come from the stdin line, never from the environment", async () => {
    process.env.BRIDGETOWN_SECRETS = "stdin"
    process.env.SLACK_USER_TOKEN = "xoxp-from-env"
    const launch = await readLaunch(lineOf({ apiToken: "t", slackUserToken: "", typesafeApiKey: "k" }))
    expect(launch.env).toMatchObject({ apiToken: "t", slackToken: undefined, typesafeKey: "k" })
    await launch.closed
  })

  test("started without the stdin line, it exits 1 before it binds or opens anything, whatever the environment holds", () => {
    const fromEnv = daemon({ BRIDGETOWN_API_TOKEN: "t", SLACK_USER_TOKEN: "xoxp-1" })
    expect(fromEnv.code).toBe(1)
    expect(fromEnv.err).toContain("make dev")
    expect(fromEnv.touchedStore).toBe(false)
    const closedEarly = daemon({ BRIDGETOWN_SECRETS: "stdin", BRIDGETOWN_API_TOKEN: "t" })
    expect(closedEarly.code).toBe(1)
    expect(closedEarly.err).toContain("expected one JSON line")
    expect(closedEarly.touchedStore).toBe(false)
  }, 30_000)
})
