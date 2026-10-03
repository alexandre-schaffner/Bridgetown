import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { run } from "../src/proc.ts"
import { childEnv, decodeSecretsLine, readFirstLine, scrubProcessEnv, secretsFromEnv } from "../src/secrets.ts"
import { sessionEnv } from "../src/sessions/sdk-options.ts"

const streamOf = (...chunks: ReadonlyArray<string>) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })

describe("stdin secrets protocol", () => {
  test("one JSON line carries the three secrets", () => {
    expect(decodeSecretsLine(JSON.stringify({ apiToken: "t", slackUserToken: "xoxp-1", typesafeApiKey: "k" }))).toEqual({
      apiToken: "t",
      slackToken: "xoxp-1",
      typesafeKey: "k",
    })
  })
  test("missing or empty optional secrets are undefined", () => {
    expect(decodeSecretsLine(JSON.stringify({ apiToken: "t", slackUserToken: null, typesafeApiKey: "" }))).toEqual({
      apiToken: "t",
      slackToken: undefined,
      typesafeKey: undefined,
    })
  })
  test("the app sends \"\" for a secret missing from Keychain: same as absent", () => {
    expect(decodeSecretsLine(JSON.stringify({ apiToken: "t", slackUserToken: "", typesafeApiKey: "" }))).toEqual({
      apiToken: "t",
      slackToken: undefined,
      typesafeKey: undefined,
    })
    expect(decodeSecretsLine(JSON.stringify({ apiToken: "", slackUserToken: "xoxp-1", typesafeApiKey: "k" }))).toBeUndefined()
  })
  test("no API token, or not JSON, is refused", () => {
    expect(decodeSecretsLine(JSON.stringify({ apiToken: "" }))).toBeUndefined()
    expect(decodeSecretsLine(JSON.stringify({ slackUserToken: "xoxp-1" }))).toBeUndefined()
    expect(decodeSecretsLine("apiToken=t")).toBeUndefined()
    expect(decodeSecretsLine("")).toBeUndefined()
  })
  test("the first line is read across chunks; EOF settles `closed`", async () => {
    const { line, closed } = await readFirstLine(streamOf('{"apiToken":', '"t"}\r\n', "ignored"))
    expect(line).toBe('{"apiToken":"t"}')
    await closed
  })
  test("EOF before any line", async () => {
    const { line, closed } = await readFirstLine(streamOf())
    expect(line).toBeUndefined()
    await closed
  })
  test("`closed` stays pending while the app holds the pipe open", async () => {
    let finish = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"apiToken":"t"}\n'))
        finish = () => controller.close()
      },
    })
    const { closed } = await readFirstLine(stream)
    let settled = false
    void closed.then(() => (settled = true))
    await Bun.sleep(10)
    expect(settled).toBe(false)
    finish()
    await closed
    expect(settled).toBe(true)
  })
})

describe("secrets never reach children", () => {
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/x",
    ANTHROPIC_API_KEY: "sk-ant",
    BRIDGETOWN_API_TOKEN: "t",
    BRIDGETOWN_SECRETS: "stdin",
    BRIDGETOWN_HOME: "/tmp/bt",
    SLACK_USER_TOKEN: "xoxp-1",
    SLACK_BOT_TOKEN: "xoxb-1",
    TYPESAFE_API_KEY: "k",
  }
  test("child env strips BRIDGETOWN_*, SLACK_*, TYPESAFE_*", () => {
    expect(childEnv(env)).toEqual({ PATH: "/usr/bin:/bin", HOME: "/Users/x", ANTHROPIC_API_KEY: "sk-ant" })
  })
  test("session env adds only what sessions need", () => {
    expect(sessionEnv(env, "s_1")).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/x",
      ANTHROPIC_API_KEY: "sk-ant",
      GH_HOST: "nocturlab.ghe.com",
      BRIDGETOWN_SESSION: "s_1",
    })
  })
  test("startup scrub removes the credentials and the launch flag", () => {
    const own = { ...env }
    expect(secretsFromEnv(own)).toEqual({ apiToken: "t", slackToken: "xoxp-1", typesafeKey: "k" })
    scrubProcessEnv(own)
    expect(Object.keys(own).filter((key) => key.includes("TOKEN") || key.includes("TYPESAFE") || key === "BRIDGETOWN_SECRETS")).toEqual([
      "SLACK_BOT_TOKEN",
    ])
  })
  test("a subprocess does not inherit a secret left in process.env", async () => {
    process.env.SLACK_USER_TOKEN = "xoxp-leak"
    try {
      const result = await Effect.runPromise(run(["/usr/bin/env"]))
      expect(result.stdout).not.toContain("xoxp-leak")
      expect(result.stdout).toContain("PATH=")
    } finally {
      delete process.env.SLACK_USER_TOKEN
    }
  })
})
