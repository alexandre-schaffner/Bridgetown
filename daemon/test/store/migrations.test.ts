import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { Effect } from "effect"
import { alertDetail, snapshot } from "../../src/api/views.ts"
import { legacyClosed, legacyDisposition, legacyPayload, legacyRelease, legacyReviewPosted, legacyTracker } from "../../src/store/migrations.ts"
import { Store } from "../../src/store/store.ts"
import { OLD_ALERTS, OLD_SESSIONS, oldStore } from "../support/old-store.ts"
import { makeWorld } from "../support/world.ts"

const home = oldStore()
const world = makeWorld({ home })
afterAll(() => world.dispose())

describe("a store the first daemon wrote", () => {
  test("every row decodes; fields added since default sensibly", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        return {
          alerts: yield* store.recentAlerts(100),
          stopped: yield* store.getSession(OLD_SESSIONS.stopped.id),
          ci: yield* store.getSession(OLD_SESSIONS.ci.id),
          actions: yield* store.listActions(),
          transcript: yield* store.transcript(OLD_SESSIONS.ci.id, 10),
        }
      }),
    )
    expect(out.alerts.map((a) => a.id).sort()).toEqual(Object.values(OLD_ALERTS).map((a) => a.id).sort())
    const release = out.alerts.find((a) => a.id === OLD_ALERTS.release.id)
    expect(release).toMatchObject({ events: [], disposition: null })
    expect(out.stopped).toMatchObject({
      milestones: { diagnosed: false, fixed: false, prOpened: false, ciGreen: false, merged: false, released: false, deployed: false },
      rootCauseFound: null, resolution: null, pushbacks: 0, mergeRequestedAt: null, releaseTag: null, deployStage: null,
    })
    expect(out.ci).toMatchObject({ mergeRequestedAt: null, releaseTag: null, deployStage: null, releasePrefix: "api" })
    expect(out.ci).toMatchObject({ provider: "claude", agentSessionId: OLD_SESSIONS.ci.claudeSessionId, agentConfigDir: null, model: OLD_SESSIONS.ci.model, effort: OLD_SESSIONS.ci.effort })
    expect(out.stopped).toMatchObject({ provider: "claude", agentSessionId: null })
    expect(out.stopped?.releasePrefix).toBeNull()
    expect(out.actions).toEqual([expect.objectContaining({ id: "a_old_review", url: null, fingerprint: null, retry: false })])
    expect(out.transcript).toHaveLength(1)
  })

  test("what only the history text said is data now: dismissed, opened, closed, a review that went out", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        return {
          dismissed: yield* store.getAlert(OLD_ALERTS.dismissed.id),
          opened: yield* store.getAlert(OLD_ALERTS.opened.id),
          closed: yield* store.getSession(OLD_SESSIONS.closedAsResolved.id),
          ci: yield* store.getSession(OLD_SESSIONS.ci.id),
          closedActive: (yield* store.activeSessions()).map((s) => s.id),
        }
      }),
    )
    expect(out.dismissed?.disposition).toEqual({ kind: "dismissed", at: "2026-10-03T11:16:49.567Z" })
    expect(out.opened?.disposition).toEqual({ kind: "opened", at: "2026-10-02T20:38:56.636Z" })
    expect(out.closed).toMatchObject({ status: "closed", resolution: "root cause not found", rootCauseFound: false })
    expect(out.ci?.review).toMatchObject({ posted: true })
    expect(out.closedActive).toEqual([OLD_SESSIONS.ci.id])
  })

  test("the snapshot and alert details are the contract's shapes, with honest outcomes", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        return {
          snapshot: yield* snapshot,
          dismissed: yield* alertDetail(OLD_ALERTS.dismissed.id),
          release: yield* alertDetail(OLD_ALERTS.release.id),
        }
      }),
    )
    const outcomes = Object.fromEntries(out.snapshot.alerts.map((a) => [a.id, [a.outcome.kind, a.outcome.headline]]))
    expect(outcomes).toEqual({
      [OLD_ALERTS.release.id]: ["session", "Stopped by you"],
      [OLD_ALERTS.dismissed.id]: ["dismissed", "Dismissed by you"],
      [OLD_ALERTS.opened.id]: ["opened", "Opened by you"],
    })
    const sessions = Object.fromEntries(out.snapshot.sessions.map((s) => [s.id, [s.status, s.headline, s.steps.length, s.acceptsMessages]]))
    expect(sessions).toEqual({
      [OLD_SESSIONS.ci.id]: ["ci", "In review · #product-approvals", 6, true],
      [OLD_SESSIONS.stopped.id]: ["stopped", "Stopped by you", 6, false],
      [OLD_SESSIONS.closedAsResolved.id]: ["closed", "Closed · root cause not found", 6, false],
    })
    // Rows from before the adversarial review: none ran, and the stepper says so instead of claiming one.
    const ci = out.snapshot.sessions.find((s) => s.id === OLD_SESSIONS.ci.id)
    expect(ci).toMatchObject({ critiqueLine: "Not run" })
    expect(ci?.steps.find((step) => step.key === "critique")).toEqual({ key: "critique", label: "No review", state: "skipped", detail: "Not run" })
    expect(out.snapshot.actions).toEqual([expect.objectContaining({ id: "a_old_review", url: null, inFlight: false, dismissCloses: false })])
    // Before history existed, the detail still says how it was triaged.
    expect(out.release?.events).toEqual([{ at: OLD_ALERTS.release.receivedAt, text: "Handed to an agent: Agent-resolvable build_failure" }])
    expect(out.release?.session?.status).toBe("stopped")
    expect(out.dismissed?.alert.outcome.sentence).toBe("No agent ran. Jev suggested one, and you dismissed it.")
  })

  test("the rewrites ran once, as migrations", () => {
    const db = new Database(join(home, "bridgetown.db"), { readonly: true })
    try {
      expect(db.query("SELECT migration_id, name FROM bridgetown_migrations ORDER BY migration_id").all()).toEqual([
        { migration_id: 1, name: "initial" },
        { migration_id: 2, name: "dispositions" },
        { migration_id: 3, name: "closed_sessions" },
        { migration_id: 4, name: "review_posted" },
        { migration_id: 5, name: "global_horizon" },
        { migration_id: 6, name: "release_prefix" },
        { migration_id: 7, name: "tracker_version" },
        { migration_id: 8, name: "action_fields" },
        { migration_id: 9, name: "agent_provider" },
      ])
      expect(db.query("SELECT status FROM sessions WHERE id = ?").get(OLD_SESSIONS.closedAsResolved.id)).toEqual({ status: "closed" })
      expect(db.query("SELECT key FROM kv ORDER BY key").all()).toEqual([{ key: "paused" }])
    } finally {
      db.close()
    }
  })
})

describe("legacy rewrites", () => {
  test("disposition: the last dismiss or open line wins; a stored disposition or no such line is left alone", () => {
    const events = [
      { at: "1", text: "Dismissed by you, no agent started" },
      { at: "2", text: "Opened by you in Slack or Revv" },
    ]
    expect(legacyDisposition({ events })?.disposition).toEqual({ kind: "opened", at: "2" })
    expect(legacyDisposition({ events, disposition: { kind: "dismissed", at: "1" } })).toBeUndefined()
    expect(legacyDisposition({ events: [{ at: "1", text: "Ignored by Jev: noise" }] })).toBeUndefined()
    expect(legacyDisposition({})).toBeUndefined()
  })
  test("closed: only a resolved session you closed; a recommendation keeps its own resolution", () => {
    expect(legacyClosed({ status: "resolved", activity: "Closed by you", outcome: "recommendation" })).toMatchObject({
      status: "closed",
      resolution: "recommendation handed to you",
      rootCauseFound: false,
    })
    expect(legacyClosed({ status: "resolved", activity: "Deployed admin-v0.6.1" })).toBeUndefined()
  })
  test("review posted: a permalink means it reached Slack", () => {
    expect(legacyReviewPosted({ review: { channelName: "c", permalink: "https://x", handledReviewId: null } })?.review).toMatchObject({ posted: true })
    expect(legacyReviewPosted({ review: { channelName: "c", permalink: null, handledReviewId: null } })?.review).toMatchObject({ posted: false })
    expect(legacyReviewPosted({ review: { channelName: "c", permalink: null, handledReviewId: null, posted: true } })).toBeUndefined()
    expect(legacyReviewPosted({ review: null })).toBeUndefined()
  })
  test("release: the agent's prefix and the tag cut or followed are told apart", () => {
    const milestones = { merged: true, released: true }
    // Named by the agent, not cut yet: a full tag is still only a prefix.
    expect(legacyRelease({ prUrl: "u", release: { image: "merkl-admin", tag: "admin-v0.6.0", version: "" }, component: "admin-v0.6.0", releaseTag: null })).toEqual({
      prUrl: "u", releasePrefix: "admin", releaseTag: null,
    })
    // Cut: the tag, and the prefix it was cut under.
    expect(legacyRelease({ prUrl: "u", milestones, release: { image: "", tag: "admin-v0.6.1", version: "v0.6.1" }, releaseTag: "admin-v0.6.1" })).toMatchObject({
      releasePrefix: "admin", releaseTag: "admin-v0.6.1",
    })
    // A re-run's: no PR of its own, only the tag it follows.
    expect(legacyRelease({ prUrl: null, release: { image: "", tag: "api-v1.2.3", version: "" } })).toMatchObject({ releasePrefix: null, releaseTag: "api-v1.2.3" })
    // Only an image to route by: nothing to release.
    expect(legacyRelease({ prUrl: "u", release: null, component: "merkl-admin" })).toEqual({ prUrl: "u", releasePrefix: null, releaseTag: null })
    expect(legacyRelease({ releasePrefix: "api", releaseTag: null })).toBeUndefined()
  })
  test("tracker: the version stored when it was read counts as taken in", () => {
    const hashes: Record<string, string> = { "C1:t": "h1" }
    expect(legacyTracker({ tracker: "C1:t" }, (id) => hashes[id])).toEqual({ tracker: { id: "C1:t", applied: "h1" } })
    expect(legacyTracker({ tracker: "C1:gone" }, (id) => hashes[id])).toEqual({ tracker: { id: "C1:gone", applied: null } })
    expect(legacyTracker({ tracker: null }, (id) => hashes[id])).toBeUndefined()
    expect(legacyTracker({ tracker: { id: "C1:t", applied: "h1" } }, (id) => hashes[id])).toBeUndefined()
  })
  test("payload: an investigate or escalate card keeps its fingerprint, a retry card says so, the rest is read elsewhere now", () => {
    expect(legacyPayload({ kind: "investigate", payload: "watch:api_5xx" })).toEqual({ kind: "investigate", fingerprint: "watch:api_5xx", retry: false })
    expect(legacyPayload({ kind: "escalate", payload: "inbox:D1:1" })).toEqual({ kind: "escalate", fingerprint: "inbox:D1:1", retry: false })
    expect(legacyPayload({ kind: "review", payload: "retry" })).toEqual({ kind: "review", fingerprint: null, retry: true })
    for (const [kind, payload] of [["review", null], ["release", "admin-v0.6.1"], ["merge", "https://ghe/pull/1"], ["rerun", "42"], ["reply", "draft"]]) {
      expect(legacyPayload({ kind, payload })).toEqual({ kind, fingerprint: null, retry: false })
    }
    expect(legacyPayload({ kind: "review", fingerprint: null, retry: true })).toBeUndefined()
  })
})
