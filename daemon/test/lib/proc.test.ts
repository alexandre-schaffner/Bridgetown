import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { run, runOk } from "../../src/lib/proc.ts"
import { scratchDir } from "../support/tmp.ts"

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A child that writes its pid, then sleeps far longer than any test. */
const sleeper = () => {
  const pidFile = join(scratchDir("bt-proc-"), "pid")
  return { pidFile, command: ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 30`] }
}

const pidOf = async (pidFile: string): Promise<number> => {
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(20)
  for (let i = 0; i < 100 && readFileSync(pidFile, "utf8").trim() === ""; i++) await Bun.sleep(20)
  return Number(readFileSync(pidFile, "utf8").trim())
}

/** The child is reaped asynchronously after the kill. */
const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(20)
  return !alive(pid)
}

describe("proc", () => {
  test("returns exit code and output", async () => {
    const result = await Effect.runPromise(run(["sh", "-c", "echo out; echo err >&2; exit 3"]))
    expect(result).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" })
    expect(await Effect.runPromise(runOk(["echo", "ok"]))).toBe("ok\n")
    const failed = await Effect.runPromise(runOk(["sh", "-c", "echo nope >&2; exit 1"]).pipe(Effect.flip))
    expect(failed.message).toBe("exited 1: nope")
  })

  test("a timeout fails the effect and kills the child", async () => {
    const { pidFile, command } = sleeper()
    const fiber = Effect.runFork(run(command, { timeoutMs: 1_000 }).pipe(Effect.flip))
    const pid = await pidOf(pidFile)
    expect(alive(pid)).toBe(true)
    const error = await Effect.runPromise(Fiber.join(fiber))
    expect(error.message).toContain("Timed out")
    expect(await gone(pid)).toBe(true)
  })

  test("interrupting the effect kills the child", async () => {
    const { pidFile, command } = sleeper()
    const fiber = Effect.runFork(run(command, { timeoutMs: 60_000 }))
    const pid = await pidOf(pidFile)
    expect(alive(pid)).toBe(true)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(await gone(pid)).toBe(true)
  })
})

test("a hard output budget stops unbounded output", async () => {
  const failed = await Effect.runPromise(run(["sh", "-c", "while :; do printf 1234567890; done"], { maxOutputBytes: 100, timeoutMs: 2000 }).pipe(Effect.flip))
  expect(failed.message).toContain("output exceeded")
})

test("trusted Git has only Bridgetown's HTTPS/auth configuration without inheriting arbitrary Git environment", async () => {
  const home = scratchDir("bt-git-env-")
  const helper = await Effect.runPromise(runOk(["git", "config", "--get-all", "credential.https://nocturlab.ghe.com.helper"], { env: { HOME: home } }))
  expect(helper.trim()).toBe("!gh auth git-credential")
  const rewrite = await Effect.runPromise(runOk(["git", "config", "--get-all", "url.https://nocturlab.ghe.com/.insteadOf"], { env: { HOME: home } }))
  expect(rewrite).toContain("nocturlab@nocturlab.ghe.com:")
})
