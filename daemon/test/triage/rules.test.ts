import { describe, expect, test } from "bun:test"
import { parseMessage } from "../../src/slack/parse.ts"
import { applyRules } from "../../src/triage/rules.ts"
import * as m from "../support/messages.ts"

const releases = { channelId: "C0AUKD42N3U", channelName: "alert-releases", myUserId: "U07ALEX" }
const uptime = { channelId: "C0B001L8UQ1", channelName: "alert-uptime", myUserId: "U07ALEX" }
const empty = { activeSessions: [], sameFingerprint: [], claimedBy: [] }

describe("rules", () => {
  test("judge failures, filter the rest", () => {
    expect(applyRules(parseMessage(m.adminBuildFailed, releases), empty)._tag).toBe("Judge")
    expect(applyRules(parseMessage(m.productionDeployFailed, releases), empty)._tag).toBe("Judge")
    expect(applyRules(parseMessage(m.apiDeployed, releases), empty)).toEqual({ _tag: "Filtered", reason: "Release deployed successfully" })
    expect(applyRules(parseMessage(m.engineWaitingApproval, releases), empty)).toEqual({ _tag: "Filtered", reason: "Waiting for approval" })
    expect(applyRules(parseMessage(m.uptimeResolved, uptime), empty)._tag).toBe("Filtered")
    expect(applyRules(parseMessage(m.degradedEnded, uptime), empty)._tag).toBe("Filtered")
    expect(applyRules(parseMessage(m.uptimeIncident, uptime), empty)._tag).toBe("Judge")
  })
})

describe("generic rules", () => {
  const infra = { channelId: "C0BL3M3CGUR", channelName: "alert-infra", myUserId: "U07ALEX" }
  const exporter = { channelId: "C0B7KBYGA11", channelName: "alert-exporter", myUserId: "U07ALEX" }
  test("success and resolved notices are filtered", () => {
    expect(applyRules(parseMessage(m.grafanaResolved, infra), empty)._tag).toBe("Filtered")
    expect(applyRules(parseMessage(m.exporterFinished, exporter), empty)._tag).toBe("Filtered")
    expect(applyRules(parseMessage(m.grafanaFiring, infra), empty)._tag).toBe("Judge")
    expect(applyRules(parseMessage(m.exporterSkipped, exporter), empty)._tag).toBe("Judge")
  })
})
