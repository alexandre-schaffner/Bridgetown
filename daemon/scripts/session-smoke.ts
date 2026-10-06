/**
 * A real Agent SDK session (it costs money) against a throwaway repo:
 * worktree → Agent SDK session → report tool → structured result → its outcome.
 * The test world with the real agent and GitHub: Slack is faked (dry run) and `origin` is a
 * local bare repo, so nothing leaves the machine but the agent's own calls.
 * Everything it writes (store, repo, worktree, the agent's conversation) goes on success; on
 * a failure or timeout it is kept for a look and the script exits 1.
 *
 *   bun scripts/session-smoke.ts
 */
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { AgentLive, claudeProjectDir } from "../src/agent/agent.ts"
import { readEnv } from "../src/config.ts"
import { Hub } from "../src/hub.ts"
import { SessionRunner } from "../src/sessions/runner.ts"
import { worktreePath } from "../src/sessions/worktree.ts"
import { GitHubLive } from "../src/ship/github.ts"
import { Store } from "../src/store/store.ts"
import { makeAlert } from "../test/support/records.ts"
import { worldLayer } from "../test/support/world.ts"

const root = mkdtempSync(join(tmpdir(), "bt-smoke-"))
mkdirSync(`${root}/repo/src`, { recursive: true })
const sh = (cmd: string, cwd = `${root}/repo`) => execSync(cmd, { cwd, stdio: "pipe" }).toString()
writeFileSync(`${root}/repo/package.json`, JSON.stringify({ name: "demo", private: true, scripts: { type: "tsc --noEmit -p ." }, devDependencies: { typescript: "^5.9.0" } }, null, 2))
writeFileSync(`${root}/repo/tsconfig.json`, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler" }, include: ["src"] }))
writeFileSync(`${root}/repo/src/price.ts`, `export interface Price {\n  readonly token: string\n  readonly usd: number\n}\n\nexport const format = (price: Price): string => \`\${price.token}: $\${price.usd.toFixed(2)}\`\n`)
writeFileSync(`${root}/repo/src/index.ts`, `import { format } from "./price"\n\nconsole.log(format({ token: "MERKL", usd: "1.25" }))\n`)
sh("git init -q -b main && git add -A && git -c user.email=bt@test -c user.name=bt -c commit.gpgsign=false commit -qm init")
sh(`git init -q --bare ${root}/origin.git`, root)
sh(`git remote add origin ${root}/origin.git && git push -q origin main`)

// The store and the worktree (the repo has no .shared) both live under the root, never in the app's own home. The
// agent is the user's own CLI, with their login, so it keeps its conversations where they do.
const { claudePath, claudeConfigDir } = readEnv()
const home = `${root}/home`
const layer = worldLayer(home, { env: { claudePath, claudeConfigDir }, agent: AgentLive(claudePath), github: GitHubLive })

const alert = makeAlert({
  id: "CTEST:1790933006.433649",
  channelId: "CTEST",
  ts: "1790933006.433649",
  title: "merkl-demo v0.0.1 · Build failed",
  summary: "Build ✗ (1 attempt failed)",
  raw: "merkl-demo\nby alex\n:red_circle:  *Build*\nBuild failed · _1 attempt failed_\nThe build step runs `bun type` (tsc --noEmit). There is no GitHub run to read in this environment; reproduce locally.",
  fingerprint: "release:merkl-demo:v0.0.1",
  fields: { _tag: "release", image: "merkl-demo", version: "v0.0.1", actor: "alex", runId: null, runUrl: null, tag: "demo-v0.0.1", stages: [{ name: "Build", status: "failure", detail: "Build failed · 1 attempt failed" }] },
  mentionsMe: true,
  receivedAt: new Date().toISOString(),
  triage: { decision: "auto", reason: "smoke", jev: { actionable: 0.95, agentResolvable: 0.9, humanOnIt: 0.01, kind: "build_failure", kindConfidence: 1, depth: "quick", urgency: 1 } },
})

/** Whether the session got as far as a structured result it did not fail on, and its branch. */
const program = Effect.gen(function* () {
  const hub = yield* Hub
  const store = yield* Store
  const runner = yield* SessionRunner
  yield* hub.updateSettings({ ...(yield* hub.settings), monorepoPath: `${root}/repo` })
  yield* store.putAlert(alert, "smoke")
  const session = yield* runner.enqueue(alert)
  yield* runner.tick
  const started = Date.now()
  let last = ""
  while (Date.now() - started < 15 * 60_000) {
    yield* Effect.sleep("3 seconds")
    const current = yield* store.getSession(session.id)
    if (current === undefined) break
    const line = `${current.status.padEnd(10)} ${current.phase.padEnd(8)} ${current.activity}`
    if (line !== last) console.log(line)
    last = line
    if (!["queued", "preparing", "running"].includes(current.status)) {
      console.log(JSON.stringify({ outcome: current.outcome, diagnosis: current.diagnosis, prUrl: current.prUrl, branch: current.branch, costUsd: current.costUsd, claudeSessionId: current.claudeSessionId }, null, 2))
      console.log("actions:", JSON.stringify(yield* store.listActions(), null, 2))
      console.log("transcript:")
      for (const entry of yield* store.transcript(session.id, 60)) console.log(`  [${entry.kind}] ${entry.text.split("\n")[0]}`)
      return { passed: current.outcome !== null && current.status !== "failed", branch: session.branch }
    }
  }
  console.log("timed out")
  return { passed: false, branch: session.branch }
})

const { passed, branch } = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
const leftovers = [root, ...(branch === null ? [] : [claudeProjectDir(claudeConfigDir, worktreePath(home, `${root}/repo`, branch))])]
if (!passed) {
  console.log(`FAILED; kept for a look: ${leftovers.join(" and ")}`)
  process.exit(1)
}
for (const path of leftovers) rmSync(path, { recursive: true, force: true })
process.exit(0)
