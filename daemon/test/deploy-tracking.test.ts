import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { alertFromParsed } from "../src/domain/alert.ts"
import { NO_MILESTONES } from "../src/domain/model.ts"
import { AlertPipeline } from "../src/pipeline/alerts.ts"
import { Shipper } from "../src/ship/shipper.ts"
import type { SlackMessage } from "../src/slack/client.ts"
import { parseMessage } from "../src/slack/parse.ts"
import { Store } from "../src/store/store.ts"
import { adminBuildFailed } from "./fixtures/messages.ts"
import { makeAlert, makeSession } from "./fixtures/records.ts"
import { fakeSlack, makeWorld } from "./fixtures/world.ts"

const RELEASES = "C0AUKD42N3U"
const TRACKER_TS = adminBuildFailed.ts
const TRACKER_ID = `${RELEASES}:${TRACKER_TS}`

/** The same tracker once its build went green: edited in place, same ts. */
const adminDeployed: SlackMessage = {
  ...adminBuildFailed,
  blocks: JSON.parse(JSON.stringify(adminBuildFailed.blocks).replace(":red_circle:  *Build*\\nBuild failed  ·  _1 attempt failed_", ":large_green_circle:  *Build*\\nImage built")),
  edited: { ts: "1790940000.000000" },
}

const trackerAlert = (sessionId: string | null) => {
  const parsed = parseMessage(adminBuildFailed, { channelId: RELEASES, channelName: "alert-releases", myUserId: undefined })
  return alertFromParsed(parsed, { permalink: null, receivedAt: "2026-10-02T11:23:26.000Z", triage: { decision: "filtered", reason: "r", jev: null }, sessionId, events: [] })
}

const tag = "admin-v0.6.0"
const released = { ...NO_MILESTONES, diagnosed: true, fixed: true, prOpened: true, critiqued: true, ciGreen: true, merged: true, released: true }

describe("a deploy in flight follows its own tracker", () => {
  // Fifteen newer posts: the tracker is no longer among the channel's newest messages.
  const newer: ReadonlyArray<SlackMessage> = Array.from({ length: 15 }, (_, i) => ({
    ts: (Date.now() / 1000 - i * 60).toFixed(6), text: `[RESOLVED] noise ${i}`, bot_id: "B1",
  }))
  const world = makeWorld({
    slack: {
      ...fakeSlack(() => []),
      latest: (channel, _limit, oldest, latest) =>
        Effect.succeed(channel !== RELEASES ? [] : oldest === TRACKER_TS && latest === TRACKER_TS ? [adminDeployed] : newer),
    },
  })
  afterAll(() => world.dispose())

  test("its edit is read however far down the channel it is, and the deploy resolves the session", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.putAlert(trackerAlert("s_dep"), "before the edit")
        yield* store.putAlert(makeAlert({ id: "C1:dep", sessionId: "s_dep" }))
        yield* store.putSession(
          makeSession("deploying", {
            id: "s_dep", alertId: "C1:dep", release: { image: "merkl-admin", tag, version: "v0.6.0" }, milestones: released,
            deployStage: { _tag: "AwaitingApproval" }, tracker: TRACKER_ID,
          }),
        )
        yield* (yield* AlertPipeline).pollOnce
        return yield* store.getSession("s_dep")
      }),
    )
    expect(out).toMatchObject({ status: "resolved", resolution: `deployed ${tag}`, milestones: { deployed: true } })
  })
})

describe("a tracker moves only the session that shipped its tag", () => {
  const world = makeWorld()
  afterAll(() => world.dispose())

  test("a PR still in CI whose agent named the full failing tag is not resolved by that tracker going green", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.putAlert(makeAlert({ id: "C1:ci", sessionId: "s_ci" }))
        yield* store.putSession(makeSession("ci", { id: "s_ci", alertId: "C1:ci", prUrl: "https://ghe/pull/1", release: { image: "merkl-admin", tag, version: "" } }))
        const parsed = parseMessage(adminDeployed, { channelId: RELEASES, channelName: "alert-releases", myUserId: undefined })
        yield* (yield* Shipper).trackDeploy(alertFromParsed(parsed, { permalink: null, receivedAt: "", triage: { decision: "filtered", reason: "r", jev: null }, sessionId: null, events: [] }))
        return yield* store.getSession("s_ci")
      }),
    )
    expect(out).toMatchObject({ status: "ci", deployStage: null, milestones: { deployed: false } })
  })
})

describe("a failed deploy sent back to an agent that cannot resume", () => {
  const world = makeWorld()
  afterAll(() => world.dispose())

  test("is handed to you with what the tracker said recorded, and no send-back pending", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.putAlert(makeAlert({ id: "C1:gone", sessionId: "s_gone" }))
        yield* store.putSession(
          makeSession("deploying", { id: "s_gone", alertId: "C1:gone", worktree: null, release: { image: "merkl-admin", tag, version: "v0.6.0" }, milestones: released }),
        )
        yield* (yield* Shipper).trackDeploy(trackerAlert(null))
        return { session: yield* store.getSession("s_gone"), cards: (yield* store.listActions()).map((a) => a.title) }
      }),
    )
    expect(out.session).toMatchObject({ status: "waiting", sentBack: null, deployStage: { _tag: "Failed", stage: "Build" }, tracker: TRACKER_ID })
    expect(out.cards).toEqual(["Agent cannot resume · t"])
  })
})
