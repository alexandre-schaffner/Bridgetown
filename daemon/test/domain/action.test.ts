import { describe, expect, test } from "bun:test"
import { type Action, cardStands, dismissCloses, openableUrl } from "../../src/domain/action.ts"
import type { Session, SessionStatus } from "../../src/domain/session.ts"
import { makeSession } from "../support/records.ts"

const session = (status: SessionStatus, overrides: Partial<Session> = {}): Session =>
  makeSession(status, { prUrl: "https://ghe/pull/1", claudeSessionId: "c", ...overrides })

describe("contract rules", () => {
  const action = (kind: Action["kind"], retry = false): Action => ({
    id: "a", kind, title: "", detail: "", primaryLabel: "", options: [], sessionId: "s", alertId: null, fingerprint: null, retry, url: null, createdAt: "",
  })
  test("dismissCloses: a stranded session's last card", () => {
    expect(dismissCloses(action("review"), session("waiting"))).toBe(true)
    expect(dismissCloses(action("release"), session("awaiting_release"))).toBe(true)
    expect(dismissCloses(action("review", true), session("failed"))).toBe(true)
    expect(dismissCloses(action("answer"), session("waiting"))).toBe(false)
    expect(dismissCloses(action("review"), session("running"))).toBe(false)
    expect(dismissCloses(action("investigate"), undefined)).toBe(false)
  })
  test("dismissCloses: a dead card closes nothing", () => {
    // A merge card left over from before the session was handed back, and an old hand-off on a session that then failed.
    expect(dismissCloses(action("merge"), session("waiting"))).toBe(false)
    expect(dismissCloses(action("review"), session("failed"))).toBe(false)
  })
  test("cardStands: a card stands only at the stage it was offered for", () => {
    const rows: ReadonlyArray<readonly [Action, SessionStatus, boolean]> = [
      [action("merge"), "awaiting_merge", true],
      [action("merge"), "running", false],
      [action("merge"), "closed", false],
      [action("release"), "awaiting_release", true],
      [action("release"), "failed", false],
      [action("rerun"), "waiting", true],
      [action("rerun"), "deploying", false],
      [action("review"), "waiting", true],
      [action("review"), "running", false],
      [action("review"), "resolved", false],
      [action("review", true), "failed", true],
      [action("review", true), "queued", false],
      [action("reply"), "resolved", true],
      [action("answer"), "running", true],
    ]
    for (const [card, status, stands] of rows) expect([card.kind, status, cardStands(card, session(status))]).toEqual([card.kind, status, stands])
    expect(cardStands(action("merge"), undefined)).toBe(false)
    expect(cardStands({ ...action("investigate"), sessionId: null }, undefined)).toBe(true)
  })
  test("L3: dismissing the merge card of a session waiting to merge closes it", () => {
    expect(dismissCloses(action("merge"), session("awaiting_merge"))).toBe(true)
    expect(dismissCloses(action("merge"), session("ci"))).toBe(false)
  })
  test("only https, slack and revv links get through", () => {
    expect(openableUrl("https://nocturlab.ghe.com/Merkl/monorepo/pull/1")).toBe("https://nocturlab.ghe.com/Merkl/monorepo/pull/1")
    expect(openableUrl("revv://pr?host=x&repo=y&number=1")).toBe("revv://pr?host=x&repo=y&number=1")
    expect(openableUrl("slack://channel?id=C1")).toBe("slack://channel?id=C1")
    expect(openableUrl("file:///etc/passwd")).toBeNull()
    expect(openableUrl("javascript:alert(1)")).toBeNull()
    expect(openableUrl("http://example.com")).toBeNull()
    expect(openableUrl("not a url")).toBeNull()
    expect(openableUrl(null)).toBeNull()
  })
})
