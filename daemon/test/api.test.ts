import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime, Schema } from "effect"
import { authorized, bind, type BoundServer, serve } from "../src/api/server.ts"
import { AdapterError, Conflict, GheBlocked, InvalidInput, MissingCredential, NotFound, SlackApiError, statusOf } from "../src/domain/errors.ts"
import { Settings } from "../src/domain/settings.ts"
import { appLayer } from "../src/layers.ts"
import { newSession } from "../src/sessions/new-session.ts"
import { Store } from "../src/store/store.ts"
import { makeAlert } from "./support/records.ts"
import { scratchDir } from "./support/tmp.ts"
import { testEnv } from "./support/world.ts"

const TOKEN = "test-token"
const home = scratchDir("bt-api-")
const env = testEnv(home, { apiToken: TOKEN, slackToken: undefined, typesafeKey: undefined })

const alert = makeAlert({
  id: "C1:1790933006.433649", ts: "1790933006.433649", title: "merkl-admin v0.6.0 · Build failed", raw: "raw text", receivedAt: "2026-10-01T00:00:00.000Z",
  triage: { decision: "ignore", reason: "noise", jev: null }, sessionId: "s_queued", events: [{ at: "2026-10-01T00:00:00.000Z", text: "Ignored by Jev: noise" }],
})

const queued = { ...newSession(alert, "s_queued", "/r"), startedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }

let server: BoundServer
let dispose = async () => {}

beforeAll(async () => {
  const rt = ManagedRuntime.make(appLayer(env))
  dispose = () => rt.dispose()
  server = bind(0)
  await rt.runPromise(
    Effect.gen(function* () {
      const store = yield* Store
      yield* store.putAlert(alert, "h")
      yield* store.putSession(queued)
      yield* store.putAction({
        id: "a_review", kind: "review", title: "Root cause not found · t", detail: "", primaryLabel: "Close session", options: [],
        sessionId: null, alertId: alert.id, fingerprint: null, retry: false, url: "file:///etc/passwd", createdAt: "2026-10-01T00:00:00.000Z",
      })
      yield* serve(server, { token: TOKEN, sse: { coalesce: "10 millis", ping: "200 millis" } })
    }),
  )
})

afterAll(async () => {
  server.stop(true)
  await dispose()
})

const call = (path: string, init: { method?: string; body?: string; token?: string | null; headers?: Record<string, string> } = {}) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.token === null ? {} : { Authorization: `Bearer ${init.token ?? TOKEN}` }), ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  })

/** The settings of a snapshot response, decoded against the contract's schema. */
const settingsOf = async (response: Promise<Response>) =>
  Schema.decodeUnknownSync(Schema.Struct({ settings: Settings }))(await (await response).json()).settings

const post = (path: string, body: unknown = {}) => call(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })

describe("auth", () => {
  test("health is open, everything else needs the token", async () => {
    expect((await call("/health", { token: null })).status).toBe(200)
    expect((await call("/state", { token: null })).status).toBe(401)
    expect((await call("/state", { token: "wrong" })).status).toBe(401)
    expect((await call("/state")).status).toBe(200)
  })
  test("a foreign Host or any Origin is refused before the token is looked at", async () => {
    expect((await call("/state", { headers: { Host: "evil.example:47621" } })).status).toBe(403)
    expect((await call("/state", { headers: { Origin: "https://evil.example" } })).status).toBe(403)
    expect((await call("/state", { headers: { Host: "localhost:47621" } })).status).toBe(200)
    expect((await call("/state", { token: null, headers: { Origin: "https://evil.example" } })).status).toBe(403)
  })
  test("503 for everything, /health included, until the routes are installed", async () => {
    const starting = bind(0)
    try {
      for (const path of ["/health", "/state"]) {
        const response = await fetch(`http://127.0.0.1:${starting.port}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ error: "starting" })
      }
    } finally {
      starting.stop(true)
    }
  })
  test("constant-time compare", () => {
    expect(authorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(authorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false)
    expect(authorized("", TOKEN)).toBe(false)
    expect(authorized(null, TOKEN)).toBe(false)
  })
})

describe("contract shape", () => {
  test("snapshot: outcome on alerts, acceptsMessages and no phase on sessions, inFlight/dismissCloses on actions", async () => {
    const text = await (await call("/state")).text()
    expect(JSON.parse(text)).toMatchObject({
      alerts: [{ outcome: { kind: "session", headline: "Queued", sentence: null, tone: "neutral" } }],
      sessions: [{ id: "s_queued", acceptsMessages: false }],
      actions: [{ id: "a_review", inFlight: false, dismissCloses: false, url: null }],
    })
    expect(text).not.toContain('"phase"')
    // What a card acts on is the daemon's business, never on the wire.
    for (const field of ['"fingerprint"', '"retry"']) expect(text).not.toContain(field)
  })
  test("logs before the first sweep: no patterns, and why none run", async () => {
    const logs: unknown = await (await call("/logs")).json()
    expect(logs).toMatchObject({ sweptAt: null, patterns: [], error: expect.stringContaining("Grafana MCP is down") })
    expect(logs).toMatchObject({ link: expect.stringMatching(/^https:\/\/grafana\.internal\.merkl\.xyz\/explore\?/) })
  })
  test("alert detail is flat", async () => {
    const detail: unknown = await (await call(`/alerts/${encodeURIComponent(alert.id)}`)).json()
    expect(typeof detail === "object" && detail !== null ? Object.keys(detail).sort() : []).toEqual(["actions", "alert", "events", "raw", "session"])
    expect(detail).toMatchObject({ raw: "raw text", session: { id: "s_queued" }, alert: { id: alert.id }, events: [{ text: "Ignored by Jev: noise" }] })
    expect(detail).not.toMatchObject({ alert: { raw: expect.anything() } })
  })
})

describe("feedback on Jev's call", () => {
  test("is stored on the alert, and its history says so", async () => {
    expect((await post(`/alerts/${encodeURIComponent(alert.id)}/feedback`, { label: "good" })).status).toBe(200)
    const detail: unknown = await (await call(`/alerts/${encodeURIComponent(alert.id)}`)).json()
    expect(detail).toMatchObject({ alert: { feedback: "good" }, events: [{ text: "Ignored by Jev: noise" }, { text: "You marked Jev's call as right" }] })
  })
})

describe("status codes", () => {
  test("404 for unknown ids", async () => {
    expect((await call("/alerts/C9%3A1")).status).toBe(404)
    expect((await call("/sessions/s_nope/transcript")).status).toBe(404)
    expect((await post("/actions/a_nope/resolve", { response: null })).status).toBe(404)
    expect((await post("/actions/a_nope/dismiss")).status).toBe(404)
    expect((await post("/alerts/C9%3A1/investigate")).status).toBe(404)
    expect((await post("/alerts/C9%3A1/feedback", { label: "good" })).status).toBe(404)
    expect((await post("/sessions/s_nope/stop")).status).toBe(404)
    expect((await post("/sessions/s_nope/message", { text: "hi" })).status).toBe(404)
    expect((await call("/nope")).status).toBe(404)
  })
  test("400 for malformed or invalid bodies", async () => {
    expect((await post("/pause", "{not json")).status).toBe(400)
    expect((await post("/pause", { paused: "yes" })).status).toBe(400)
    expect((await post(`/alerts/${encodeURIComponent(alert.id)}/feedback`, { label: "meh" })).status).toBe(400)
    expect((await post("/settings", { maxConcurrent: "x" })).status).toBe(400)
    expect((await post("/settings", { maxConcurrent: 0 })).status).toBe(400)
    expect((await post("/settings", { thresholds: { autoActionable: 3 } })).status).toBe(400)
    expect((await post("/settings", { quietHours: { start: "25:00" } })).status).toBe(400)
    expect((await call("/alerts/%E0%A4%A")).status).toBe(400)
  })
  test("409 for a message the session cannot take", async () => {
    const response = await post("/sessions/s_queued/message", { text: "hi" })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("queued") })
  })
  test("a valid settings patch merges", async () => {
    const response = await post("/settings", { maxConcurrent: 3, quietHours: { start: "23:00" } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ settings: { maxConcurrent: 3, quietHours: { enabled: false, start: "23:00", end: "08:00" } } })
  })
  test("settings merge key by key, keep what the patch leaves out, and survive a read", async () => {
    const before = await settingsOf(call("/state"))
    const response = await post("/settings", { thresholds: { autoActionable: 0.9 }, channels: [{ id: "C9", name: "alert-x", enabled: true }] })
    expect(response.status).toBe(200)
    const after = await settingsOf(Promise.resolve(response))
    expect(after.thresholds).toEqual({ ...before.thresholds, autoActionable: 0.9 })
    expect(after.channels).toEqual([{ id: "C9", name: "alert-x", enabled: true }])
    expect(after.maxConcurrent).toBe(3)
    expect(after.quietHours).toEqual(before.quietHours)
    expect(await settingsOf(call("/state"))).toEqual(after)
  })
  test("a rejected settings patch changes nothing", async () => {
    const before = await settingsOf(call("/state"))
    expect((await post("/settings", { pollSeconds: -1, maxConcurrent: 5 })).status).toBe(400)
    expect(await settingsOf(call("/state"))).toEqual(before)
  })
  test("405 for a method no route takes; errors are JSON", async () => {
    const response = await call("/state", { method: "DELETE" })
    expect(response.status).toBe(405)
    expect(await response.json()).toEqual({ error: "method not allowed" })
    expect(await (await call("/state", { token: "wrong" })).json()).toEqual({ error: "unauthorized" })
  })
  test("one mapping from typed failures to statuses", () => {
    expect(statusOf(new InvalidInput({ message: "" }))).toBe(400)
    expect(statusOf(new NotFound({ message: "" }))).toBe(404)
    expect(statusOf(new Conflict({ message: "" }))).toBe(409)
    expect(statusOf(new AdapterError({ adapter: "sqlite", operation: "x", message: "", cause: null }))).toBe(500)
    expect(statusOf(new MissingCredential({ service: "slack", message: "" }))).toBe(500)
    expect(statusOf(new SlackApiError({ method: "chat.postMessage", code: "not_posted", message: "" }))).toBe(500)
    expect(statusOf(new GheBlocked({ operation: "gh pr merge", message: "" }))).toBe(500)
  })
})

describe("SSE", () => {
  /** Reads the stream until `done` says enough, or gives up after `ms`. */
  const readEvents = async (done: (text: string) => boolean, act: () => Promise<unknown> = async () => {}, ms = 3_000) => {
    const response = await call("/events")
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error("no body")
    const decoder = new TextDecoder()
    let text = ""
    const deadline = Date.now() + ms
    let acted = false
    while (!done(text) && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => undefined)])
      if (chunk === undefined || chunk.done) break
      text += decoder.decode(chunk.value)
      if (!acted && text.includes("event: snapshot")) {
        acted = true
        await act()
      }
    }
    await reader.cancel()
    return text
  }
  const snapshots = (text: string) => text.split("\n\n").filter((e) => e.startsWith("event: snapshot\ndata: "))

  test("a snapshot on connect, then pings", async () => {
    const text = await readEvents((t) => t.includes(": ping"))
    const first = snapshots(text)[0] ?? ""
    expect(JSON.parse(first.slice("event: snapshot\ndata: ".length))).toMatchObject({ status: { dryRun: true }, sessions: [{ id: "s_queued" }] })
    expect(text).toContain(": ping\n\n")
  })
  test("every change sends a fresh snapshot", async () => {
    const text = await readEvents(
      (t) => snapshots(t).some((e) => e.includes('"paused":true')),
      () => post("/pause", { paused: true }),
    )
    expect(snapshots(text).length).toBeGreaterThanOrEqual(2)
    expect(snapshots(text).at(-1)).toContain('"paused":true')
    await post("/pause", { paused: false })
  })
})
