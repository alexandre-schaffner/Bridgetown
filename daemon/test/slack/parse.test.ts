import { describe, expect, test } from "bun:test"
import { parseMessage } from "../../src/slack/parse.ts"
import * as m from "../support/messages.ts"

const releases = { channelId: "C0AUKD42N3U", channelName: "alert-releases", myUserId: "U07ALEX" }
const uptime = { channelId: "C0B001L8UQ1", channelName: "alert-uptime", myUserId: "U07ALEX" }
const engine = { channelId: "C0AUK4AUER0", channelName: "alert-engine", myUserId: "U07ALEX" }

describe("release tracker", () => {
  test("build failure", () => {
    const alert = parseMessage(m.adminBuildFailed, releases)
    expect(alert.title).toBe("merkl-admin v0.6.0 · Build failed")
    expect(alert.fingerprint).toBe("release:merkl-admin:v0.6.0")
    expect(alert.fields).toMatchObject({
      _tag: "release",
      image: "merkl-admin",
      version: "v0.6.0",
      actor: "alex",
      runId: "291250187",
      tag: "admin-v0.6.0",
    })
    expect(alert.summary).toBe("Approval ✓ · Build ✗ (1 attempt failed)")
  })

  test("two failed attempts", () => {
    const alert = parseMessage(m.exporterBuildFailed, releases)
    expect(alert.title).toBe("merkl-states-exporter v0.1.0 · Build failed")
    expect(alert.summary).toContain("2 attempts failed")
  })

  test("all green deploy", () => {
    const alert = parseMessage(m.apiDeployed, releases)
    expect(alert.title).toBe("merkl-api v1.35.9 · Deployed")
    if (alert.fields._tag !== "release") throw new Error("expected release")
    expect(alert.fields.stages.map((s) => s.name)).toEqual(["Build", "Front Staging", "Engine", "Front Production"])
    expect(alert.fields.stages.every((s) => s.status === "success")).toBe(true)
  })

  test("waiting for approval", () => {
    const alert = parseMessage(m.engineWaitingApproval, releases)
    expect(alert.title).toBe("merkl v1.62.33 · Waiting for approval")
  })

  test("grouped environment sub-stages", () => {
    const alert = parseMessage(m.productionDeployFailed, releases)
    if (alert.fields._tag !== "release") throw new Error("expected release")
    expect(alert.fields.stages.map((s) => [s.name, s.status])).toEqual([
      ["Approval", "success"],
      ["Front Staging", "success"],
      ["Build", "success"],
      ["Production › API", "success"],
      ["Production › ETL", "failure"],
    ])
    expect(alert.title).toBe("merkl-api v1.36.0 · Production › ETL deploy failed")
  })

  test("failure ping mentions me", () => {
    const alert = parseMessage(m.failurePing, releases)
    expect(alert.mentionsMe).toBe(true)
  })
})

describe("uptime", () => {
  test("incident started", () => {
    const alert = parseMessage(m.uptimeIncident, uptime)
    expect(alert.fields).toEqual({ _tag: "uptime", target: "api.merkl.xyz/v4/roots/delay", state: "incident" })
    expect(alert.title).toBe("Incident started · api.merkl.xyz/v4/roots/delay")
  })
  test("resolved", () => {
    expect(parseMessage(m.uptimeResolved, uptime).fields).toEqual({ _tag: "uptime", target: "rewards.plasma.to", state: "resolved" })
  })
  test("ssl and degraded", () => {
    expect(parseMessage(m.sslExpiry, uptime).fields).toMatchObject({ state: "ssl_expiry", target: "merkl.xyz" })
    expect(parseMessage(m.degradedEnded, uptime).fields).toMatchObject({ state: "recovered", target: "api.merkl.xyz" })
  })
})

describe("engine", () => {
  test("stellar tree root", () => {
    const alert = parseMessage(m.stellarTreeRoot, engine)
    expect(alert.fields).toMatchObject({
      _tag: "engine",
      subject: "Merkl Computation Run on Stellar",
      txHash: "d94107d987f786387ee6a2787c1db9979cb50c128f26bfd5405268f327892fa5",
    })
    expect(alert.title.startsWith("Merkl Computation Run on Stellar · Failed to update tree root")).toBe(true)
    const again = parseMessage({ ...m.stellarTreeRoot, ts: "1", text: m.stellarTreeRoot.text?.replace("d941", "aaaa") }, engine)
    expect(again.fingerprint).toBe(alert.fingerprint)
  })
  test("prisma", () => {
    const alert = parseMessage(m.prismaCancelled, engine)
    expect(alert.title).toContain("Campaign with job index")
  })
})

describe("generic", () => {
  const infra = { channelId: "C0BL3M3CGUR", channelName: "alert-infra", myUserId: "U07ALEX" }
  const exporter = { channelId: "C0B7KBYGA11", channelName: "alert-exporter", myUserId: "U07ALEX" }
  test("grafana alerts skip the group ping", () => {
    const firing = parseMessage(m.grafanaFiring, infra)
    expect(firing.title.startsWith("[FIRING:1] eRPC P95")).toBe(true)
    expect(firing.fingerprint).toBe(parseMessage({ ...m.grafanaFiring, ts: "2" }, infra).fingerprint)
  })
  test("snake_case survives title cleaning", () => {
    expect(parseMessage(m.exporterSkipped, exporter).title.startsWith("state_descriptions_latest: skipped")).toBe(true)
    expect(parseMessage(m.exporterFinished, exporter).title).toBe("states-exporter run finished")
  })
})

describe("attachments", () => {
  const infra = { channelId: "C0BL3M3CGUR", channelName: "alert-infra", myUserId: "U07ALEX" }
  const prices = { channelId: "C0AUCLN8LLB", channelName: "alert-missing-prices", myUserId: "U07ALEX" }
  test("grafana title comes before the body", () => {
    expect(parseMessage(m.grafanaResolved, infra).title.startsWith("[RESOLVED] eRPC P95")).toBe(true)
  })
  test("link unfurls are not part of the alert", () => {
    expect(parseMessage(m.missingPriceWithUnfurl, prices).raw).not.toContain("Etherscan")
  })
})
