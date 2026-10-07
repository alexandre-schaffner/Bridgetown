import { describe, expect, test } from "bun:test"
import { alertOutcome } from "../../src/domain/alert-outcome.ts"
import type { Alert, Decision, Disposition } from "../../src/domain/alert.ts"
import type { Session } from "../../src/domain/session.ts"
import { makeAlert, makeSession } from "../support/records.ts"

const alert = (decision: Decision, disposition: Disposition["kind"] | null = null): Alert =>
  makeAlert({
    triage: { decision, reason: "because", jev: null },
    // History text must not matter: only `disposition` does.
    events: [{ at: "", text: "Dismissed by you, no agent started" }],
    disposition: disposition === null ? null : { kind: disposition, at: "" },
  })

const session = makeSession

type Row = readonly [string, Alert, Session | undefined, number, string, string, string]

describe("alert outcome", () => {
  const rows: ReadonlyArray<Row> = [
    // label, alert, session, open cards → kind, headline, tone
    ["filtered", alert("filtered"), undefined, 0, "filtered", "Filtered by a rule", "neutral"],
    ["ignored", alert("ignore"), undefined, 0, "ignored", "Ignored by Jev", "neutral"],
    ["suggested", alert("suggest"), undefined, 0, "suggested", "Suggested to you", "neutral"],
    ["escalated", alert("escalate"), undefined, 0, "escalated", "Escalated to you", "neutral"],
    ["auto, nothing started", alert("auto"), undefined, 0, "suggested", "Handed to an agent", "neutral"],
    ["suggested with an open card", alert("suggest"), undefined, 1, "waiting", "Waiting on you", "waiting"],
    ["escalated with an open card", alert("escalate"), undefined, 1, "waiting", "Waiting on you", "waiting"],
    ["auto while paused, card open", alert("auto"), undefined, 1, "waiting", "Waiting on you", "waiting"],
    ["an open card beats an older dismissal", alert("suggest", "dismissed"), undefined, 1, "waiting", "Waiting on you", "waiting"],
    ["dismissed suggestion", alert("suggest", "dismissed"), undefined, 0, "dismissed", "Dismissed by you", "neutral"],
    ["dismissed escalation", alert("escalate", "dismissed"), undefined, 0, "dismissed", "Dismissed by you", "neutral"],
    ["opened escalation", alert("escalate", "opened"), undefined, 0, "opened", "Opened by you", "neutral"],
    ["a finding withdrawn once its signal recovered", alert("auto", "withdrawn"), undefined, 0, "withdrawn", "Back to normal", "neutral"],
    ["running session wins over ignore", alert("ignore"), session("running"), 0, "session", "Agent working", "live"],
    ["running session wins over filtered (attached repeat)", alert("filtered"), session("running"), 0, "session", "Agent working", "live"],
    ["queued session wins over a dismissal", alert("suggest", "dismissed"), session("queued"), 0, "session", "Queued", "neutral"],
    ["waiting session wins over its own card", alert("auto"), session("waiting"), 1, "session", "Waiting on you", "waiting"],
    [
      "resolved session is the only green",
      alert("auto"),
      session("resolved", { resolution: "deployed admin-v0.6.1" }),
      0,
      "session",
      "Resolved · deployed admin-v0.6.1",
      "success",
    ],
    ["closed session is neutral", alert("auto"), session("closed", { resolution: "root cause not found" }), 0, "session", "Closed · root cause not found", "neutral"],
    ["failed session", alert("auto"), session("failed", { resolution: "agent failed" }), 0, "session", "Failed · agent failed", "failure"],
    ["stopped session", alert("ignore"), session("stopped"), 0, "session", "Stopped by you", "neutral"],
  ]
  for (const [label, a, s, cards, kind, headline, tone] of rows) {
    test(label, () => expect(alertOutcome(a, s, cards)).toMatchObject({ kind, headline, tone }))
  }

  test("a sentence says what happened when no agent ran; a session speaks for itself", () => {
    expect(alertOutcome(alert("ignore"), undefined, 0).sentence).toBe("No agent ran. Jev ignored it.")
    expect(alertOutcome(alert("escalate", "dismissed"), undefined, 0).sentence).toBe("No agent ran. Jev sent it to you, and you dismissed it.")
    expect(alertOutcome(alert("auto"), session("running"), 0).sentence).toBeNull()
  })

  test("never green without a verified session", () => {
    for (const decision of ["filtered", "ignore", "suggest", "auto", "escalate"] as const) {
      for (const disposition of [null, "dismissed", "opened"] as const) {
        for (const cards of [0, 1]) expect(alertOutcome(alert(decision, disposition), undefined, cards).tone).not.toBe("success")
      }
    }
  })
})
