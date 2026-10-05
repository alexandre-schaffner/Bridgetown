/**
 * End-to-end check of the session pipeline against a throwaway repo:
 * worktree → Agent SDK session → report tool → structured result → finalize.
 * Slack is faked (dry run) and `origin` is a local bare repo, so nothing leaves the machine.
 *
 *   BRIDGETOWN_HOME=/tmp/bt-e2e/home bun scripts/e2e-session.ts
 */
import { execSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { Effect, Layer } from "effect"
import { readEnv } from "../src/config.ts"
import type { Alert } from "../src/domain/model.ts"
import { Hub, HubLive } from "../src/hub.ts"
import { ActionQueueLive } from "../src/actions/queue.ts"
import { AgentLive } from "../src/sessions/agent.ts"
import { AsksLive } from "../src/sessions/asks.ts"
import { SessionRepoLive } from "../src/sessions/repo.ts"
import { SessionRunner, SessionRunnerLive } from "../src/sessions/runner.ts"
import { WorktreesLive } from "../src/sessions/worktree.ts"
import { GitHubLive } from "../src/ship/github.ts"
import { SlackClientLive } from "../src/slack/client.ts"
import { SlackThreadLive } from "../src/slack/thread.ts"
import { Store, StoreLive } from "../src/store/store.ts"

const root = "/tmp/bt-e2e"
rmSync(root, { recursive: true, force: true })
mkdirSync(`${root}/repo/src`, { recursive: true })
const sh = (cmd: string, cwd = `${root}/repo`) => execSync(cmd, { cwd, stdio: "pipe" }).toString()
writeFileSync(`${root}/repo/package.json`, JSON.stringify({ name: "demo", private: true, scripts: { type: "tsc --noEmit -p ." }, devDependencies: { typescript: "^5.9.0" } }, null, 2))
writeFileSync(`${root}/repo/tsconfig.json`, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler" }, include: ["src"] }))
writeFileSync(`${root}/repo/src/price.ts`, `export interface Price {\n  readonly token: string\n  readonly usd: number\n}\n\nexport const format = (price: Price): string => \`\${price.token}: $\${price.usd.toFixed(2)}\`\n`)
writeFileSync(`${root}/repo/src/index.ts`, `import { format } from "./price"\n\nconsole.log(format({ token: "MERKL", usd: "1.25" }))\n`)
sh("git init -q -b main && git add -A && git -c user.email=bt@test -c user.name=bt commit -qm init")
sh(`git init -q --bare ${root}/origin.git`, root)
sh(`git remote add origin ${root}/origin.git && git push -q origin main`)

const env = { ...readEnv(), slackToken: undefined, forceDryRun: true }
const base = Layer.mergeAll(StoreLive(`${root}/home`), SlackClientLive(undefined), AgentLive, GitHubLive)
const withHub = HubLive(env).pipe(Layer.provideMerge(base))
const records = Layer.mergeAll(SlackThreadLive, SessionRepoLive, ActionQueueLive, WorktreesLive).pipe(Layer.provideMerge(withHub))
const layer = SessionRunnerLive.pipe(Layer.provideMerge(AsksLive.pipe(Layer.provideMerge(records))))

const alert: Alert = {
  id: "CTEST:1790933006.433649",
  channelId: "CTEST",
  channelName: "alert-releases",
  ts: "1790933006.433649",
  permalink: null,
  title: "merkl-demo v0.0.1 · Build failed",
  summary: "Build ✗ (1 attempt failed)",
  raw: "merkl-demo\nby alex\n:red_circle:  *Build*\nBuild failed · _1 attempt failed_\nThe build step runs `bun type` (tsc --noEmit). There is no GitHub run to read in this environment; reproduce locally.",
  source: "releases",
  fingerprint: "release:merkl-demo:v0.0.1",
  fields: { _tag: "release", image: "merkl-demo", version: "v0.0.1", actor: "alex", runId: null, runUrl: null, tag: "demo-v0.0.1", stages: [{ name: "Build", status: "failure", detail: "Build failed · 1 attempt failed" }] },
  mentionsMe: true,
  receivedAt: new Date().toISOString(),
  triage: { decision: "auto", reason: "e2e", jev: { actionable: 0.95, agentResolvable: 0.9, humanOnIt: 0.01, kind: "build_failure", kindConfidence: 1, depth: "quick", urgency: 1 } },
  sessionId: null,
  feedback: null,
  events: [],
  disposition: null,
  claimedBy: [],
}

const program = Effect.gen(function* () {
  const hub = yield* Hub
  const store = yield* Store
  const runner = yield* SessionRunner
  yield* hub.updateSettings({ ...(yield* hub.settings), monorepoPath: `${root}/repo` })
  yield* store.putAlert(alert, "e2e")
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
      return
    }
  }
  console.log("timed out")
})

await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
process.exit(0)
