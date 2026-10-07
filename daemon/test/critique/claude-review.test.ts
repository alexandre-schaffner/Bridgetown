import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { claudeReview, type ReviewRequest } from "../../src/critique/reviewer.ts"
import { RESULT } from "../support/agent.ts"
import { commit, scratchRepo, sh } from "../support/repo.ts"
import { result } from "../support/sdk.ts"

describe("Claude reviewing", () => {
  test("reads the pushed diff, rejects write/shell/subagent tools, and validates its verdict", async () => {
    const worktree = scratchRepo()
    writeFileSync(join(worktree, "fix.ts"), "export const fixed = true\n")
    sh("git add fix.ts", worktree)
    commit("fix", worktree)
    const head = sh("git rev-parse HEAD", worktree)
    const request: ReviewRequest = { worktree, head, profile: { vendor: "claude", model: "custom-reviewer", effort: "max" }, prompt: "Review this fix" }
    const verdict = { summary: "sound", findings: [] }
    let closed = false
    const actual = await Effect.runPromise(claudeReview(request, "/fake/claude", ({ prompt, options }) => {
      expect(prompt).toContain("+export const fixed = true")
      expect(options).toMatchObject({ model: "custom-reviewer", effort: "max", tools: ["Read", "Glob", "Grep"], permissionMode: "dontAsk", persistSession: false, mcpServers: {}, strictMcpConfig: true, settingSources: [] })
      return {
        close: () => { closed = true },
        async *[Symbol.asyncIterator]() {
          const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0]
          if (hook === undefined) throw new Error("missing reviewer guard")
          for (const tool_name of ["Bash", "Write", "Edit", "Agent", "Task", "mcp__external__write"]) {
            expect(await hook({ hook_event_name: "PreToolUse", tool_name, tool_input: {}, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: worktree }, undefined, { signal: new AbortController().signal }))
              .toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
          }
          yield { ...result("s", RESULT, 0), structured_output: verdict }
        },
      }
    }))
    expect(actual).toEqual(verdict)
    expect(closed).toBe(true)
  })

  test("a missing structured verdict fails the review instead of passing it", async () => {
    const worktree = scratchRepo()
    const request: ReviewRequest = { worktree, head: sh("git rev-parse HEAD", worktree), profile: { vendor: "claude", model: "custom", effort: null }, prompt: "Review" }
    let closed = false
    const exit = await Effect.runPromise(Effect.exit(claudeReview(request, undefined, () => ({
      close: () => { closed = true },
      async *[Symbol.asyncIterator]() { yield { ...result("s", RESULT, 0), structured_output: { summary: "all good" } } },
    }))))
    expect(exit._tag).toBe("Failure")
    expect(closed).toBe(true)
  })
})
