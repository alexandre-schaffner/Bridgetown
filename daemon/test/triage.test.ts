import { describe, expect, test } from "bun:test"
import { DEFAULT_SETTINGS } from "../src/config.ts"
import type { JevVerdict } from "../src/domain/model.ts"
import { parseMessage } from "../src/slack/parse.ts"
import { decide, decideAnomaly } from "../src/triage/policy.ts"
import { applyRules } from "../src/triage/rules.ts"
import * as m from "./fixtures/messages.ts"

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
    expect(applyRules(parseMessage(m.humanMessage, uptime), empty)._tag).toBe("Filtered")
  })
})

const verdict = (overrides: Partial<JevVerdict>): JevVerdict => ({
  actionable: 0.9,
  agentResolvable: 0.9,
  humanOnIt: 0.05,
  kind: "build_failure",
  kindConfidence: 0.9,
  depth: "standard",
  urgency: 1,
  ...overrides,
})

describe("policy", () => {
  const t = DEFAULT_SETTINGS.thresholds
  test("auto when confident and unclaimed", () => {
    expect(decide(verdict({}), t).decision).toBe("auto")
  })
  test("claimed alerts downgrade to suggest", () => {
    expect(decide(verdict({ humanOnIt: 0.7 }), t).decision).toBe("suggest")
  })
  test("borderline is suggest", () => {
    expect(decide(verdict({ actionable: 0.6, agentResolvable: 0.5 }), t).decision).toBe("suggest")
  })
  test("ignore informational and human-only", () => {
    expect(decide(verdict({ actionable: 0.1 }), t).decision).toBe("ignore")
    expect(decide(verdict({ agentResolvable: 0.1 }), t).decision).toBe("ignore")
  })
  test("an anomaly is investigated unless Jev sees nothing in it, then suggested", () => {
    expect(decideAnomaly(verdict({}), t).decision).toBe("auto")
    expect(decideAnomaly(verdict({ actionable: 0.6, agentResolvable: 0.5 }), t).decision).toBe("auto")
    expect(decideAnomaly(verdict({ humanOnIt: 0.7 }), t).decision).toBe("auto")
    expect(decideAnomaly(verdict({ actionable: 0.1 }), t)).toMatchObject({ decision: "suggest", reason: expect.stringContaining("Jev doubts it") })
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
