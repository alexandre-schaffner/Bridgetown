import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Hub } from "../../src/hub.ts"
import { SessionRepo } from "../../src/sessions/repo.ts"
import { Store } from "../../src/store/store.ts"
import { makeAlert, makeSession } from "../support/records.ts"
import { makeWorld } from "../support/world.ts"
import { handleEvent, impliedPhase, mcpProblem } from "../../src/agent/events.ts"

describe("implied phase", () => {
  test("edits mean fixing, gh pr create means pr", () => {
    expect(impliedPhase("Edit", { file_path: "x" })).toBe("fix")
    expect(impliedPhase("Bash", { command: "GH_HOST=x gh pr create --base main" })).toBe("pr")
    expect(impliedPhase("Bash", { command: "gh pr checks 12 --watch" })).toBe("ci")
    expect(impliedPhase("Bash", { command: "gh run view 1 --log-failed" })).toBeUndefined()
  })
})

describe("MCP problems in a session's transcript", () => {
  test("Codex servers are the user's own, so the user's Codex fixes them", () => {
    expect(mcpProblem("notion", "failed", "codex")).toBe("notion MCP · sessions: failed. Check `codex mcp get notion`.")
  })
  test("a login problem says where the login works", () => {
    expect(mcpProblem("notion", "needs-auth")).toBe("notion MCP · sessions: needs a login. Run `claude mcp login notion`.")
  })

  test("other states name themselves", () => {
    expect(mcpProblem("notion", "failed")).toBe("notion MCP · sessions: failed. Check `claude mcp get notion`.")
  })

  test("a broken server of the user's stays in that session, not in the app's problems", async () => {
    const world = makeWorld()
    try {
      const { problem, transcript } = await world.runPromise(Effect.gen(function* () {
        const repo = yield* SessionRepo, hub = yield* Hub, store = yield* Store
        yield* store.putAlert(makeAlert({ id: "mcp" }))
        yield* repo.create(makeSession("running", { id: "mcp", alertId: "mcp" }))
        const servers = [{ name: "bridgetown", status: "connected" }, { name: "plugin:revv:review", status: "failed" }, { name: "notion", status: "connected" }]
        yield* handleEvent("mcp", { kind: "init", conversationId: "c", servers }, { repo, closeInput: () => {}, onEnd: () => Effect.void })
        return { problem: yield* hub.problemFor("mcp"), transcript: yield* store.transcript("mcp", 10) }
      }))
      expect(problem).toBeNull()
      expect(transcript.find((entry) => entry.kind === "error")?.text).toBe("MCP: plugin:revv:review failed, notion connected. plugin:revv:review MCP · sessions: failed. Check `claude mcp get plugin:revv:review`.")
    } finally { await world.dispose() }
  })
})

test("Claude and Codex broker tools both log activity and advance phases", async () => {
  const world = makeWorld()
  try {
    const rows = await world.runPromise(Effect.gen(function* () {
      const repo = yield* SessionRepo, store = yield* Store
      const rows = []
      for (const prefix of ["", "mcp__bridgetown__"]) {
        const id = prefix === "" ? "events-codex" : "events-claude"
        yield* store.putAlert(makeAlert({ id }))
        yield* repo.create(makeSession("running", { id, alertId: id, phase: "diagnose" }))
        const sink = { repo, closeInput: () => {}, onEnd: () => Effect.void }
        yield* handleEvent(id, { kind: "tool", name: `${prefix}bt_write_file`, input: { path: "src/fix.ts" } }, sink)
        const fix = (yield* repo.get(id))?.phase
        yield* handleEvent(id, { kind: "tool", name: `${prefix}bt_submit_fix`, input: { title: "fix: correct it" } }, sink)
        rows.push({ fix, phase: (yield* repo.get(id))?.phase, transcript: yield* store.transcript(id, 10) })
      }
      return rows
    }))
    for (const row of rows) {
      expect(row.fix).toBe("fix");expect(row.phase).toBe("pr")
      expect(row.transcript.filter((entry) => entry.kind === "tool")).toHaveLength(2)
    }
  } finally { await world.dispose() }
})
