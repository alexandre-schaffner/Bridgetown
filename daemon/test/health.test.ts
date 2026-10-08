import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Fiber, Record, Schema } from "effect"
import { Health } from "../src/health.ts"
import { Hub } from "../src/hub.ts"
import { runOk } from "../src/lib/proc.ts"
import { Scheduler, SCHEDULER_TIMING, type SchedulerTiming } from "../src/scheduler.ts"
import { scratchDir } from "./support/tmp.ts"
import { eventually } from "./support/wait.ts"
import { makeWorld } from "./support/world.ts"

test("Bun health rechecks the installed version and clears a stale setup warning independently of memory", async () => {
  const repo = scratchDir("bt-bun-health-")
  const pin = (version: string) => writeFileSync(join(repo, "package.json"), JSON.stringify({ packageManager: `bun@${version}` }))
  const local = (await Effect.runPromise(runOk(["bun", "--version"]))).trim()
  const world = makeWorld()
  try {
    await world.runPromise(Effect.gen(function* () {
      const hub = yield* Hub
      const health = yield* Health
      yield* hub.updateSettings({ ...(yield* hub.settings), monorepoPath: repo, deploymentRepoPath: "" })
      yield* hub.problem("memory", "A separate memory problem")
      pin("0.0.1")
      yield* health.probeBun
      expect((yield* hub.status).error).toContain(`this machine has bun ${local}`)
      pin(local)
      yield* health.probeBun
      expect((yield* hub.status).error).toBe("A separate memory problem")
      yield* hub.problem("memory", null)
      expect((yield* hub.status).error).toBeNull()
    }))
  } finally { await world.dispose() }
})

test("the scheduler clears a stale Bun warning without another worktree or session", async () => {
  const repo = scratchDir("bt-bun-refresh-")
  const local = (await Effect.runPromise(runOk(["bun", "--version"]))).trim()
  writeFileSync(join(repo, "package.json"), JSON.stringify({ packageManager: `bun@${local}` }))
  const world = makeWorld()
  try {
    await world.runPromise(Effect.gen(function* () {
      const hub = yield* Hub
      yield* hub.updateSettings({ ...(yield* hub.settings), monorepoPath: repo, deploymentRepoPath: "" })
      yield* hub.problem("setup", "The repo pins bun but the cached installed version is old")
      const timing: SchedulerTiming = { ...Record.map(SCHEDULER_TIMING, () => ({ every: "1 hour", first: "1 hour" })), bun: { every: "20 millis" } }
      const running = yield* (yield* Scheduler).run(timing).pipe(Effect.forkChild)
      yield* eventually(hub.status, (status) => status.error === null ? true : undefined)
      yield* Fiber.interrupt(running)
      expect((yield* hub.status).error).toBeNull()
    }))
  } finally { await world.dispose() }
})

test("Bun health follows both configured repositories, path changes and removed pins", async () => {
  const matching = scratchDir("bt-bun-matching-")
  const mismatching = scratchDir("bt-bun-mismatching-")
  const local = (await Effect.runPromise(runOk(["bun", "--version"]))).trim()
  writeFileSync(join(matching, "package.json"), JSON.stringify({ packageManager: `bun@${local}` }))
  writeFileSync(join(mismatching, "package.json"), JSON.stringify({ packageManager: "bun@99.98.97" }))
  const world = makeWorld()
  try {
    await world.runPromise(Effect.gen(function* () {
      const hub = yield* Hub
      const health = yield* Health
      yield* hub.updateSettings({ ...(yield* hub.settings), monorepoPath: matching, deploymentRepoPath: mismatching })
      yield* health.probeBun
      expect((yield* hub.status).error).toContain("pins bun 99.98.97")
      yield* hub.updateSettings({ ...(yield* hub.settings), deploymentRepoPath: matching })
      yield* health.probeBun
      expect((yield* hub.status).error).toBeNull()
      yield* hub.updateSettings({ ...(yield* hub.settings), monorepoPath: mismatching, deploymentRepoPath: "" })
      yield* health.probeBun
      expect((yield* hub.status).error).toContain("pins bun 99.98.97")
      writeFileSync(join(mismatching, "package.json"), "{}")
      yield* health.probeBun
      expect((yield* hub.status).error).toBeNull()
    }))
  } finally { await world.dispose() }
})

for (const failure of ["missing", "nonzero", "empty"]) test(`a ${failure} Bun version check preserves warnings until readiness is confirmed`, async () => {
  const home = scratchDir("bt-bun-probe-")
  const repo = scratchDir("bt-bun-probe-repo-")
  const bin = scratchDir("bt-bun-probe-bin-")
  writeFileSync(join(repo, "package.json"), JSON.stringify({ packageManager: "bun@0.0.1" }))
  if (failure !== "missing") writeFileSync(join(bin, "bun"), failure === "nonzero" ? `#!/bin/sh\necho ${Bun.version}\nexit 7\n` : "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  const sourceRoot = join(import.meta.dir, "..")
  const code = `import { Effect, ManagedRuntime } from ${JSON.stringify(join(sourceRoot, "node_modules/effect/dist/index.js"))};
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { Hub } from ${JSON.stringify(join(sourceRoot, "src/hub.ts"))};
    import { Health } from ${JSON.stringify(join(sourceRoot, "src/health.ts"))};
    import { worldLayer } from ${JSON.stringify(join(sourceRoot, "test/support/world-layer.ts"))};
    const world = ManagedRuntime.make(worldLayer(process.argv[1]));
    const originalPath = process.env.PATH;
    try { console.log(JSON.stringify(await world.runPromise(Effect.gen(function* () {
      const hub = yield* Hub;
      const health = yield* Health;
      yield* hub.updateSettings({ ...(yield* hub.settings), monorepoPath: process.argv[2], deploymentRepoPath: "" });
      yield* health.probeBun;
      const before = (yield* hub.status).error;
      process.env.PATH = process.argv[3];
      yield* health.probeBun;
      const after = (yield* hub.status).error;
      yield* hub.problem("setup", null);
      yield* health.probeBun;
      const unknown = (yield* hub.status).error;
      process.env.PATH = originalPath;
      writeFileSync(join(process.argv[2], "package.json"), JSON.stringify({ packageManager: "bun@" + Bun.version }));
      yield* health.probeBun;
      return { before, after, unknown, healthy: (yield* hub.status).error };
    })))); } finally { process.env.PATH = originalPath; await world.dispose(); }`
  const child = Bun.spawn([process.execPath, "--eval", code, home, repo, bin], { stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(exit, stderr).toBe(0)
  const result = Schema.decodeUnknownSync(Schema.Struct({ before: Schema.String, after: Schema.String, unknown: Schema.String, healthy: Schema.Null }))(JSON.parse(stdout))
  expect(result.before).toContain("pins bun 0.0.1")
  expect(result.after).toBe(result.before)
  expect(result.unknown).toContain("Bun readiness check failed:")
  expect(result.healthy).toBeNull()
})
