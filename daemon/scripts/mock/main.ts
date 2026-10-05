#!/usr/bin/env bun
/**
 * Mock Bridgetown daemon for developing and screenshotting the app: the real
 * daemon (store, runner, shipper, gates, actions, HTTP/SSE, views) on a
 * throwaway store, with Slack, Jev, the Agent SDK and GitHub faked. Nothing
 * leaves the machine; worktrees come from a local git repo with a local origin.
 *
 *   bun scripts/mock/main.ts                      # 127.0.0.1:47621, token "dev"
 *   BRIDGETOWN_PORT=47650 bun scripts/mock/main.ts
 *   MOCK_EXTRA=1 …          # the running agent also asks a question (answer card with quick replies)
 *   MOCK_GITHUB=blocked …   # start with GHE refusing this network; `kill -USR1 <pid>` toggles it
 *   MOCK_RELEASE_HOLD_SECONDS=600 …  # how long the release in flight at startup takes
 *   MOCK_GRAFANA=live …     # real prod charts through the local grafana MCP (read-only) instead of fake series
 *   MOCK_STATIC=1 …         # nothing moves: no loops, no agents, the release held in flight (make e2e)
 *   MOCK_WORLD=empty …      # a fresh install that has received nothing yet
 *   MOCK_NOW=2026-10-04T12:00:00Z …  # the wall clock stopped there (clock.ts)
 *   MOCK_ROOT=/tmp/bt-mock …  # the throwaway root at a fixed path rather than a temp dir
 *   MOCK_API_TOKEN=other …  # answers only this token, so the app that launched it is rejected
 *
 * Launched like the daemon (`BRIDGETOWN_DAEMON_CMD="bun …/scripts/mock/main.ts"`),
 * it reads its token from stdin and exits when stdin closes. Later lines on stdin
 * steer it: `{"mock":"status","patch":{"github":"blocked"}}` patches the status (its `error` is
 * reported as a problem, which is what shows there),
 * `{"mock":"crash","code":98}` exits at once with that code, as a crash would.
 *
 * Then: make dev-app (BRIDGETOWN_ATTACH=1 BRIDGETOWN_API_TOKEN=dev swift run --package-path app Bridgetown)
 */
import "./clock.ts"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Layer, Schedule, Schema } from "effect"
import { Actions } from "../../src/actions/actions.ts"
import { bind, serve } from "../../src/api/server.ts"
import type { Env } from "../../src/config.ts"
import { Critic } from "../../src/critique/critic.ts"
import { Reviewer } from "../../src/critique/reviewer.ts"
import { now } from "../../src/domain/ids.ts"
import type { Alert, Stage } from "../../src/domain/model.ts"
import { Grafana, GrafanaLive } from "../../src/grafana/client.ts"
import { Health } from "../../src/health.ts"
import { Hub } from "../../src/hub.ts"
import { appLayerWith } from "../../src/layers.ts"
import { readLaunch, runDaemon } from "../../src/launch.ts"
import { AlertPipeline } from "../../src/pipeline/alerts.ts"
import { Agent, type AgentShape } from "../../src/sessions/agent.ts"
import { SessionRepo } from "../../src/sessions/repo.ts"
import { SessionRunner } from "../../src/sessions/runner.ts"
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
import { buildFixtures, IN_FLIGHT_TAG, LOG_FINDING_FINGERPRINT, SESSION } from "./fixtures.ts"
import { fakeGrafana, SWEEP_ROWS } from "./grafana.ts"
import { scriptFor } from "./scripts.ts"

const staticWorld = process.env.MOCK_STATIC === "1"
const world = process.env.MOCK_WORLD === "empty" ? "empty" : "full"
const holdSeconds = Number(process.env.MOCK_RELEASE_HOLD_SECONDS ?? 600)

// Launched by hand, the token defaults to "dev"; launched by the app, it comes on stdin and this is ignored.
process.env.BRIDGETOWN_API_TOKEN ??= "dev"
/**
 * Launched like the daemon, one branch of stdin carries the launch (the secrets line, then
 * EOF when the app goes) and the other the control lines. By hand stdin is the terminal and
 * is left alone: reading it from a background job (`make mock &`) would stop the mock.
 */
let controlInput: ReturnType<typeof Bun.stdin.stream> | undefined
const launch = await readLaunch(() => {
  const [launchInput, control] = Bun.stdin.stream().tee()
  controlInput = control
  return launchInput
})
const token = process.env.MOCK_API_TOKEN || launch.env.apiToken

// Bound first, like the daemon: a taken port exits 98 before anything is created.
const server = bind(launch.env.port)

/** Marks a root as the mock's, so a fixed MOCK_ROOT is only ever replaced when a mock made it. */
const ROOT_MARK = ".bridgetown-mock"

/** The throwaway root: MOCK_ROOT (replacing what a crashed run left there) or a new temp dir. Removed when the mock exits. */
const mockRoot = Effect.acquireRelease(
  Effect.sync(() => {
    const fixed = process.env.MOCK_ROOT
    if (fixed === undefined || fixed === "") return mkdtempSync(join(tmpdir(), "bt-mock-"))
    if (existsSync(fixed) && readdirSync(fixed).length > 0 && !existsSync(join(fixed, ROOT_MARK))) {
      throw new Error(`MOCK_ROOT ${fixed} is not empty and was not made by the mock; refusing to replace it`)
    }
    rmSync(fixed, { recursive: true, force: true })
    mkdirSync(fixed, { recursive: true })
    return fixed
  }).pipe(Effect.tap((root) => Effect.sync(() => writeFileSync(join(root, ROOT_MARK), "")))),
  (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
)

/** The monorepo stand-in: one commit, pushed to a bare origin next to it, so worktree setup runs for real and offline. */
const makeRepo = (root: string) =>
  Effect.sync(() => {
    const repoPath = join(root, "monorepo")
    const sh = (command: string, cwd: string) => execSync(command, { cwd, stdio: "pipe" })
    mkdirSync(repoPath, { recursive: true })
    writeFileSync(join(repoPath, "README.md"), "Bridgetown mock monorepo\n")
    sh("git init -q -b main && git add -A && git -c user.email=mock@bridgetown -c user.name=mock -c commit.gpgsign=false commit -qm init", repoPath)
    sh(`git init -q --bare ${join(root, "origin.git")}`, root)
    sh(`git remote add origin ${join(root, "origin.git")} && git push -q origin main`, repoPath)
    return repoPath
  })

/** A static world runs no agent; one asked to start is a bug in the world, not something to fake. */
const noAgent: AgentShape = {
  query: () => {
    throw new Error("MOCK_STATIC: a static world starts no agent")
  },
}

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

/** A line on stdin after the launch: patch the status, or exit as a crash would. Anything else is ignored. */
const Control = Schema.Union([
  Schema.Struct({
    mock: Schema.Literal("status"),
    patch: Schema.Struct({
      paused: Schema.optionalKey(Schema.Boolean),
      slack: Schema.optionalKey(Schema.Literals(["ok", "error", "missing_token"])),
      jev: Schema.optionalKey(Schema.Literals(["ok", "error", "missing_key"])),
      grafanaMcp: Schema.optionalKey(Schema.Literals(["up", "down"])),
      github: Schema.optionalKey(Schema.Literals(["ok", "blocked", "unknown"])),
      error: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  }),
  Schema.Struct({ mock: Schema.Literal("crash"), code: Schema.Int }),
])
const decodeControl = Schema.decodeUnknownOption(Schema.fromJsonString(Control))

/** Reads control lines until stdin closes, applying each. */
const steer = (input: ReturnType<typeof Bun.stdin.stream>) =>
  Effect.gen(function* () {
    const hub = yield* Hub
    const reader = input.pipeThrough(new TextDecoderStream()).getReader()
    let buffered = ""
    while (true) {
      const chunk = yield* Effect.promise(() => reader.read())
      if (chunk.done) return
      buffered += chunk.value
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        const command = decodeControl(line)
        if (command._tag === "None") continue
        if (command.value.mock === "crash") process.exit(command.value.code)
        const { error, ...status } = command.value.patch
        yield* hub.patchStatus(status)
        // Only a problem sets the status's error: this one stands as a failed poll's would, until a line clears it
        // (or, live, the next poll round does, as it would a real one).
        if (error !== undefined) yield* hub.problem("poll", error)
      }
    }
  })

const program = Effect.gen(function* () {
  const root = yield* mockRoot
  // Sessions' worktrees live under it too (`appSupportDir`); a caller's own home is kept.
  process.env.BRIDGETOWN_HOME ??= join(root, "home")
  const home = process.env.BRIDGETOWN_HOME
  const repoPath = yield* makeRepo(root)
  const fixtures = buildFixtures({ now: Date.now(), repoPath, worktrees: join(home, "worktrees", "monorepo"), world, static: staticWorld })

  /** Releases cut during this run, and when: the tracker below walks each through approval, build and production. */
  const released: Array<{ readonly tag: string; readonly at: number }> = []
  const fake = makeFakeGitHub({
    prs: fixtures.prs,
    tags: fixtures.tags,
    latencyMs: 3_000,
    // A static world keeps the release in flight for good.
    holds: { [IN_FLIGHT_TAG]: staticWorld ? Infinity : holdSeconds * 1_000 },
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

  const agent = staticWorld ? noAgent : scriptedAgent(scriptFor({ extra: process.env.MOCK_EXTRA === "1", prs: new Map(fixtures.sessions.map((s) => [s.id, s.prUrl])) }))
  const env: Env = { ...launch.env, apiToken: token, slackToken: "xoxp-mock", typesafeKey: "mock", jevModel: "mock" }
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

  const run = Effect.gen(function* () {
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
    // The log sweep, with Jev's verdicts on its patterns already stored: the Goldsky one is the fixtures' log finding.
    // A fresh install has not swept yet.
    if (process.env.MOCK_GRAFANA !== "live" && world === "full") yield* saveJudged(store, mockVerdicts())
    if (staticWorld && world === "full") yield* watcher.sweepLogs

    // The release in flight: a real resolve through the gates, held up in the fake `gh release create`.
    const inFlight = fixtures.actions.find((a) => a.kind === "release" && a.sessionId === SESSION.inFlight)
    if (inFlight !== undefined) {
      yield* actions.resolve(inFlight.id, null).pipe(
        Effect.catchCause((cause) => Effect.logWarning("in-flight release failed", cause)),
        Effect.forkScoped,
      )
      // Static: served once the tag is being cut, so the first snapshot is the one that stays.
      const session = inFlight.sessionId
      while (staticWorld && session !== null && ((yield* repo.get(session))?.releaseTag ?? null) === null) yield* Effect.sleep("10 millis")
    }
    yield* serve(server, { token })
    if (controlInput !== undefined) yield* steer(controlInput).pipe(Effect.forkScoped)

    if (!staticWorld) {
      // The daemon's loops, faster: sessions start (unless GHE is blocked), CI and merges move, Slack is "polled".
      yield* every("schedule", "1 second", hub.status.pipe(Effect.flatMap((status) => (status.github === "blocked" ? Effect.void : runner.tick))))
      yield* every("ship", "10 seconds", shipper.tick)
      yield* every("critique", "3 seconds", critic.tick)
      yield* every("poll", "30 seconds", pipeline.pollOnce)
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
    }

    process.on("SIGUSR1", () => {
      const blocked = fake.toggleBlocked()
      console.log(`GitHub Enterprise ${blocked ? "blocked (IP allow list)" : "reachable again"}`)
      void Effect.runPromise(health.probeGithub)
    })

    console.log(
      [
        `mock bridgetown daemon on http://127.0.0.1:${server.port} (${staticWorld ? "static" : "live"}, ${world} world, pid ${process.pid})`,
        `store ${home}`,
        `kill -USR1 ${process.pid} toggles "GitHub blocked"; ${IN_FLIGHT_TAG} is in flight ${staticWorld ? "for good" : `for ${holdSeconds}s`}`,
      ].join("\n"),
    )
    return yield* Effect.never
  })

  return yield* run.pipe(Effect.provide(layer))
})

runDaemon(program, launch)
