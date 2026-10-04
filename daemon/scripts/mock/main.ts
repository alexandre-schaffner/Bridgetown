#!/usr/bin/env bun
/**
 * Mock Bridgetown daemon for developing and screenshotting the menu bar app:
 * the real daemon (store, runner, shipper, gates, actions, HTTP/SSE, views) on
 * a throwaway store, with Slack, Jev, the Agent SDK and GitHub faked. Nothing
 * leaves the machine; worktrees come from a local git repo with a local origin.
 *
 *   bun scripts/mock/main.ts                      # 127.0.0.1:47621, token "dev"
 *   BRIDGETOWN_PORT=47650 bun scripts/mock/main.ts
 *   MOCK_EXTRA=1 …          # the running agent also asks a question (answer card with quick replies)
 *   MOCK_GITHUB=blocked …   # start with GHE refusing this network; `kill -USR1 <pid>` toggles it
 *   MOCK_RELEASE_HOLD_SECONDS=600 …  # how long the release in flight at startup takes
 *   MOCK_GRAFANA=live …     # real prod charts through the local grafana MCP (read-only) instead of fake series
 *
 * Then: make dev-app (BRIDGETOWN_ATTACH=1 BRIDGETOWN_API_TOKEN=dev swift run --package-path app Bridgetown)
 */
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunRuntime } from "@effect/platform-bun"
import { Duration, Effect, Layer, Runtime, Schedule } from "effect"
import { Actions } from "../../src/actions/actions.ts"
import { bind, serve } from "../../src/api/server.ts"
import type { Env } from "../../src/config.ts"
import { Critic } from "../../src/critique/critic.ts"
import { Reviewer } from "../../src/critique/reviewer.ts"
import { now } from "../../src/domain/ids.ts"
import type { Alert, Stage } from "../../src/domain/model.ts"
import { Health } from "../../src/health.ts"
import { Hub } from "../../src/hub.ts"
import { appLayerWith } from "../../src/layers.ts"
import { AlertPipeline } from "../../src/pipeline/alerts.ts"
import { Agent } from "../../src/sessions/agent.ts"
import { SessionRepo } from "../../src/sessions/repo.ts"
import { SessionRunner } from "../../src/sessions/runner.ts"
import { Grafana, GrafanaLive } from "../../src/grafana/client.ts"
import { GitHub } from "../../src/ship/github.ts"
import { Shipper } from "../../src/ship/shipper.ts"
import { SlackClient } from "../../src/slack/client.ts"
import { Store, StoreLive } from "../../src/store/store.ts"
import { Jev } from "../../src/triage/jev.ts"
import { patternKey } from "../../src/watch/logs.ts"
import { type Judged, saveJudged } from "../../src/watch/sweep-store.ts"
import { Watcher } from "../../src/watch/watcher.ts"
import { scriptedAgent } from "./agent.ts"
import { fakeJev, fakeReviewer, fakeSlack, makeFakeGitHub } from "./fakes.ts"
import { fakeGrafana, SWEEP_ROWS } from "./grafana.ts"
import { buildFixtures, IN_FLIGHT_TAG, LOG_FINDING_FINGERPRINT } from "./fixtures.ts"
import { scriptFor } from "./scripts.ts"

const port = Number(process.env.BRIDGETOWN_PORT ?? 47621)
const token = process.env.BRIDGETOWN_API_TOKEN ?? "dev"
const holdSeconds = Number(process.env.MOCK_RELEASE_HOLD_SECONDS ?? 600)

// Bound first, like the daemon: a taken port exits 98 before anything is created.
const server = bind(port)

const root = mkdtempSync(join(tmpdir(), "bt-mock-"))
const home = join(root, "home")
process.env.BRIDGETOWN_HOME = home

/** The monorepo stand-in: one commit, pushed to a bare origin next to it, so worktree setup runs for real and offline. */
const repoPath = join(root, "monorepo")
const sh = (command: string, cwd: string) => execSync(command, { cwd, stdio: "pipe" })
mkdirSync(repoPath, { recursive: true })
writeFileSync(join(repoPath, "README.md"), "Bridgetown mock monorepo\n")
sh("git init -q -b main && git add -A && git -c user.email=mock@bridgetown -c user.name=mock -c commit.gpgsign=false commit -qm init", repoPath)
sh(`git init -q --bare ${join(root, "origin.git")}`, root)
sh(`git remote add origin ${join(root, "origin.git")} && git push -q origin main`, repoPath)

const fixtures = buildFixtures({ repoPath, worktrees: join(home, "worktrees", "monorepo") })

/** Releases cut during this run, and when: the tracker below walks each through approval, build and production. */
const released: Array<{ readonly tag: string; readonly at: number }> = []

const fake = makeFakeGitHub({
  prs: fixtures.prs,
  tags: fixtures.tags,
  latencyMs: 3_000,
  holds: { [IN_FLIGHT_TAG]: holdSeconds * 1_000 },
  blocked: process.env.MOCK_GITHUB === "blocked",
  onRelease: (tag) => released.push({ tag, at: Date.now() }),
})

/** What the mock's Jev said about each sweep pattern, keyed as the sweep keys them. */
const mockVerdicts = (): Record<string, Judged> => {
  const finding = fixtures.alerts.find((a) => a.fingerprint === LOG_FINDING_FINGERPRINT)
  return Object.fromEntries(
    SWEEP_ROWS.flatMap((row) => {
      if (row.verdict === null) return []
      const alertId = row.verdict.problem >= fixtures.settings.thresholds.suggestActionable ? (finding?.id ?? null) : null
      return [[patternKey(row.sweep, row.fields._msg ?? ""), { at: new Date(Date.now() - 24 * 60_000).toISOString(), verdict: row.verdict, alertId }]]
    }),
  )
}

const agent = scriptedAgent(scriptFor({ extra: process.env.MOCK_EXTRA === "1", prs: new Map(fixtures.sessions.map((s) => [s.id, s.prUrl])) }))

const env: Env = { port, apiToken: token, slackToken: "xoxp-mock", typesafeKey: "mock", forceDryRun: false, jevModel: "mock" }
const layer = appLayerWith(
  env,
  Layer.mergeAll(
    StoreLive(home),
    Layer.succeed(SlackClient)(fakeSlack),
    Layer.succeed(Jev)(fakeJev),
    Layer.succeed(Agent)(agent),
    Layer.succeed(Reviewer)(fakeReviewer()),
    Layer.succeed(GitHub)(fake.github),
    // MOCK_GRAFANA=live reads real prod charts through the local grafana MCP (read-only).
    process.env.MOCK_GRAFANA === "live" ? GrafanaLive : Layer.succeed(Grafana)(fakeGrafana()),
  ),
)

/** The release tracker's message for `tag`, `elapsed` ms after the tag was cut. */
const trackerStages = (elapsed: number): ReadonlyArray<Stage> => {
  const stage = (name: string, status: Stage["status"]): Stage => ({ name, status, detail: "" })
  if (elapsed < 15_000) return [stage("Approval", "pending")]
  if (elapsed < 25_000) return [stage("Approval", "success"), stage("Build", "in_progress")]
  if (elapsed < 35_000) return [stage("Approval", "success"), stage("Build", "success"), stage("Production", "in_progress")]
  return [stage("Approval", "success"), stage("Build", "success"), stage("Production", "success")]
}

const trackerAlert = (tag: string, stages: ReadonlyArray<Stage>): Alert => {
  const ts = (Date.now() / 1000).toFixed(6)
  return {
    id: `C0AUKD42N3U:${ts}`, channelId: "C0AUKD42N3U", channelName: "alert-releases", ts, permalink: null, title: `Deployment ${tag}`, summary: "", raw: "",
    source: "releases", fingerprint: `release:${tag}`, mentionsMe: false, receivedAt: now(), sessionId: null, feedback: null, events: [], disposition: null, claimedBy: [],
    fields: { _tag: "release", image: tag.replace(/-v\d.*$/, ""), version: tag.slice(tag.lastIndexOf("-v") + 1), actor: "alex", runId: null, runUrl: null, tag, stages },
    triage: { decision: "filtered", reason: "Release tracker", jev: null },
  }
}

/** Runs `effect` every `every`, logging failures, on a fiber of the program's scope. */
const every = <E, R>(name: string, interval: Duration.Input, effect: Effect.Effect<unknown, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) => Effect.logWarning(`mock ${name} failed`, cause)),
    Effect.repeat(Schedule.spaced(interval)),
    Effect.forkScoped,
  )

const program = Effect.gen(function* () {
  const store = yield* Store
  const hub = yield* Hub
  const repo = yield* SessionRepo
  const runner = yield* SessionRunner
  const shipper = yield* Shipper
  const critic = yield* Critic
  const health = yield* Health
  const actions = yield* Actions
  const pipeline = yield* AlertPipeline
  const watcher = yield* Watcher

  yield* hub.updateSettings(fixtures.settings)
  for (const alert of fixtures.alerts) yield* store.putAlert(alert, "mock")
  for (const session of fixtures.sessions) yield* store.putSession(session)
  for (const action of fixtures.actions) yield* store.putAction(action)
  for (const [sessionId, entries] of Object.entries(fixtures.transcripts)) {
    for (const entry of entries) yield* store.appendTranscript(sessionId, entry)
  }
  yield* hub.patchStatus({ grafanaMcp: "up", lastPollAt: now() })
  // Live Grafana: the real probe decides, so a stopped container shows as down.
  if (process.env.MOCK_GRAFANA === "live") yield* health.probeGrafana
  yield* health.probeGithub
  yield* serve(server, { token })

  // The release in flight: a real resolve through the gates, held up in the fake `gh release create`.
  const inFlight = fixtures.actions.find((a) => a.kind === "release" && a.payload === IN_FLIGHT_TAG)
  if (inFlight !== undefined) {
    yield* actions.resolve(inFlight.id, null).pipe(
      Effect.catchCause((cause) => Effect.logWarning("in-flight release failed", cause)),
      Effect.forkScoped,
    )
  }

  // The daemon's loops, faster: sessions start (unless GHE is blocked), CI and merges move, Slack is "polled".
  yield* every("schedule", "1 second", hub.status.pipe(Effect.flatMap((status) => (status.github === "blocked" ? Effect.void : runner.tick))))
  yield* every("ship", "10 seconds", shipper.tick)
  yield* every("critique", "3 seconds", critic.tick)
  yield* every("poll", "30 seconds", pipeline.pollOnce)
  // The log sweep, with Jev's verdicts on its patterns already stored: the Goldsky one is the fixtures' log finding.
  if (process.env.MOCK_GRAFANA !== "live") yield* saveJudged(store, mockVerdicts())
  yield* every("logs", "600 seconds", watcher.sweepLogs)
  // The SDK reports cost only when a turn ends; ticking it shows the app's cost label update live.
  yield* every(
    "cost",
    "6 seconds",
    Effect.gen(function* () {
      for (const session of yield* store.activeSessions()) {
        if (session.status !== "running") continue
        yield* repo.modify(session.id, (current) => (current.status === "running" ? { ...current, costUsd: Math.round((current.costUsd + 0.03) * 100) / 100 } : undefined))
      }
    }),
  )
  yield* every(
    "tracker",
    "5 seconds",
    Effect.forEach(released, ({ tag, at }) => shipper.trackDeploy(trackerAlert(tag, trackerStages(Date.now() - at))), { discard: true }),
  )

  process.on("SIGUSR1", () => {
    const blocked = fake.toggleBlocked()
    console.log(`GitHub Enterprise ${blocked ? "blocked (IP allow list)" : "reachable again"}`)
    void Effect.runPromise(health.probeGithub)
  })

  console.log(
    [
      `mock bridgetown daemon on http://127.0.0.1:${server.port} (token "${token}", pid ${process.pid})`,
      `store ${home}`,
      `kill -USR1 ${process.pid} toggles "GitHub blocked"; ${IN_FLIGHT_TAG} is in flight for ${holdSeconds}s`,
    ].join("\n"),
  )
  return yield* Effect.never
})

BunRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(layer)), {
  teardown: (exit, onExit) =>
    Runtime.defaultTeardown(exit, (code) => {
      server.stop(true)
      rmSync(root, { recursive: true, force: true })
      onExit(code)
      process.exit(code)
    }),
})
