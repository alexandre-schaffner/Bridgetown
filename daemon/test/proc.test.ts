import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { run, runOk } from "../src/proc.ts"
import { scratchDir } from "./fixtures/tmp.ts"

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
