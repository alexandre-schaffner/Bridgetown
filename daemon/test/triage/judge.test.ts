import { describe, expect, test } from "bun:test"
import { parseMessage } from "../../src/slack/parse.ts"
import { alertState } from "../../src/triage/judge.ts"
import * as m from "../support/messages.ts"

const uptime = { channelId: "C0B001L8UQ1", channelName: "alert-uptime", myUserId: "U07ALEX" }

describe("what Jev reads about an alert", () => {
  test("a prod finding's channel is Grafana, as the context explains it", () => {
    const finding = { ...parseMessage(m.grafanaFiring, uptime), source: "watch" as const, channelName: "Grafana" }
    const state = alertState({ alert: finding, thread: [], reactions: [], history: [] })
    expect(state.alert.channel).toBe("Grafana")
    expect(state.context).toContain("channel is Grafana (no #)")
  })
})
