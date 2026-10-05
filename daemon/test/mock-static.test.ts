import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ASK, buildFixtures, SESSION, STILL_SESSION, type WorldOptions } from "../scripts/mock/fixtures.ts"
import { scratchDir } from "./fixtures/tmp.ts"

const NOW = "2026-10-04T12:00:00.000Z"
const scratch = scratchDir("bt-mock-test-")
/** This process's env without the store an earlier `makeWorld` pointed it at (and removed): the mock makes its own. */
const inherited = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "BRIDGETOWN_HOME"))

const world = (overrides: Partial<WorldOptions> = {}) =>
  buildFixtures({ now: Date.parse(NOW), repoPath: "/repo", worktrees: "/home/worktrees/monorepo", world: "full", static: true, ...overrides })

describe("the static mock world", () => {
  test("is the same on every build", () => {
    expect(JSON.stringify(world())).toBe(JSON.stringify(world()))
  })

  test("holds every agent mid-turn instead of starting it", () => {
    const fixtures = world()
    const status = (id: string) => fixtures.sessions.find((s) => s.id === id)?.status
    expect(status(SESSION.running)).toBe("running")
    expect(status(SESSION.ask)).toBe("waiting")
    expect(status(STILL_SESSION.queued)).toBe("queued")
    expect(status(STILL_SESSION.preparing)).toBe("preparing")
    const answer = fixtures.actions.find((a) => a.kind === "answer")
    expect(answer).toMatchObject({ sessionId: SESSION.ask, title: ASK.question, options: [...ASK.options] })
  })

  test("live, the scripted agents start from the queue and put up their own cards", () => {
    const fixtures = world({ static: false })
    expect(fixtures.sessions.find((s) => s.id === SESSION.running)?.status).toBe("queued")
    expect(fixtures.sessions.some((s) => s.id === STILL_SESSION.queued)).toBe(false)
    expect(fixtures.actions.some((a) => a.kind === "answer")).toBe(false)
  })

  test("the empty world has received nothing", () => {
    const fixtures = world({ world: "empty" })
    expect([fixtures.alerts, fixtures.sessions, fixtures.actions]).toEqual([[], [], []])
  })
})

/** A port nothing listens on, from the OS. */
const freePort = () => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = probe.port
  probe.stop(true)
  return port
}

/** The mock started the way the app starts the daemon: the token on stdin, the pipe held open. */
const launch = (env: Record<string, string> = {}) => {
  const port = Number(env.BRIDGETOWN_PORT ?? freePort())
  const child = Bun.spawn(["bun", join(import.meta.dir, "../scripts/mock/main.ts")], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
    env: { ...inherited(), BRIDGETOWN_SECRETS: "stdin", BRIDGETOWN_PORT: String(port), MOCK_STATIC: "1", MOCK_NOW: NOW, MOCK_ROOT: join(scratch, "root"), ...env },
  })
  child.stdin.write(`${JSON.stringify({ apiToken: "t0ken", slackUserToken: "", typesafeApiKey: "" })}\n`)
  child.stdin.flush()
  /** The first answer past the boot: nothing listens at first, then every request gets 503 until the routes are in. */
  const served = async (): Promise<Response> => {
    for (let i = 0; i < 200; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/state`, { headers: { Authorization: "Bearer t0ken" } }).catch(() => undefined)
      if (response !== undefined && response.status !== 503) return response
      await Bun.sleep(50)
    }
    throw new Error(`the mock never served /state: ${await new Response(child.stderr).text()}`)
  }
  const state = async (): Promise<string> => {
    const response = await served()
    expect(response.status).toBe(200)
    return response.text()
  }
  const send = (line: unknown) => {
    child.stdin.write(`${JSON.stringify(line)}\n`)
    child.stdin.flush()
  }
  return { child, served, state, send }
}

describe("the mock honours the daemon's launch contract", () => {
  test("serves the same snapshot every run, and exits when stdin closes, taking its root with it", async () => {
    const first = launch()
    const before = await first.state()
    await Bun.sleep(1_000)
    expect(await first.state()).toBe(before)
    first.child.stdin.end()
    expect(await first.child.exited).toBe(0)
    expect(existsSync(join(scratch, "root"))).toBe(false)

    const second = launch()
    expect(await second.state()).toBe(before)
    second.child.stdin.end()
    expect(await second.child.exited).toBe(0)
  }, 30_000)

  test("control lines on stdin patch the status, and crash with the given code", async () => {
    const mock = launch()
    await mock.state()
    mock.send({ mock: "status", patch: { github: "blocked", slack: "missing_token" } })
    let status: unknown
    for (let i = 0; i < 100; i++) {
      status = JSON.parse(await mock.state()).status
      if ((status as { github?: string }).github === "blocked") break
      await Bun.sleep(20)
    }
    expect(status).toMatchObject({ github: "blocked", slack: "missing_token" })
    // The error a line names is shown (it is reported as a problem, the only thing that sets it), and goes with null.
    const errorAfter = async (error: string | null) => {
      mock.send({ mock: "status", patch: { error } })
      let shown: unknown
      for (let i = 0; i < 100; i++) {
        shown = JSON.parse(await mock.state()).status.error
        if (shown === error) break
        await Bun.sleep(20)
      }
      return shown
    }
    expect(await errorAfter("Couldn't read the store: database is locked")).toBe("Couldn't read the store: database is locked")
    expect(await errorAfter(null)).toBeNull()
    mock.send({ mock: "crash", code: 3 })
    expect(await mock.child.exited).toBe(3)
  }, 30_000)

  test("launched by hand, it reads no control lines: stdin is the terminal there", async () => {
    const mock = launch({ BRIDGETOWN_SECRETS: "", BRIDGETOWN_API_TOKEN: "t0ken" })
    await mock.state()
    mock.send({ mock: "crash", code: 3 })
    await Bun.sleep(300)
    expect(mock.child.exitCode).toBeNull()
    await mock.state()
    mock.child.kill()
    await mock.child.exited
  }, 30_000)

  test("a taken port exits 98", async () => {
    const holder = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    const mock = launch({ BRIDGETOWN_PORT: String(holder.port) })
    expect(await mock.child.exited).toBe(98)
    holder.stop(true)
  }, 30_000)

  test("answers only MOCK_API_TOKEN when it is set, so the app that launched it is rejected", async () => {
    const mock = launch({ MOCK_API_TOKEN: "someone-else" })
    expect((await mock.served()).status).toBe(401)
    mock.child.stdin.end()
    await mock.child.exited
  }, 30_000)
})
