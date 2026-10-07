import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { codexArgs, execFailure, REVIEWERS, sweepReviewSandboxes, Verdict, VERDICT_JSON_SCHEMA } from "../../src/critique/reviewer.ts"
import { ReviewFinding } from "../../src/domain/critique.ts"
import { scratchDir } from "../support/tmp.ts"

describe("automatic reviewing", () => {
  test("retains the Codex depth profiles", () => {
    for (const reviewer of Object.values(REVIEWERS)) expect(reviewer.vendor).not.toBe("claude")
    expect(REVIEWERS.deep).toEqual({ vendor: "codex", model: "gpt-5.6-sol", effort: "xhigh" })
  })
})

describe("codex exec", () => {
  test("read-only, ephemeral, without the user's config, with Bridgetown's model and output schema", () => {
    const args = codexArgs("/opt/homebrew/bin/codex", { worktree: "/w", head: "aaaa111", profile: REVIEWERS.standard, prompt: "review it" }, "/t/schema.json", "/t/out.json")
    expect(args).toEqual([
      "/opt/homebrew/bin/codex", "exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--cd", "/w",
      "--model", "gpt-5.6-sol", "--config", 'model_reasoning_effort="high"', "--output-schema", "/t/schema.json",
      "--output-last-message", "/t/out.json", "--color", "never", "review it",
    ])
  })
  test("the verdict schema is strict and has no severity tier", () => {
    const item = VERDICT_JSON_SCHEMA.properties.findings.items
    expect(item.additionalProperties).toBe(false)
    expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort() as Array<(typeof item.required)[number]>)
    expect(Object.keys(item.properties)).not.toContain("severity")
    expect(Object.keys(item.properties).sort()).toEqual(Object.keys(ReviewFinding.fields).sort())
  })
  test("a failed run says why in one line", () => {
    const stderr = "ERROR: Reconnecting... 5/5\nERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"
    expect(execFailure({ exitCode: 1, stdout: "", stderr })).toBe("codex is not logged in: run `codex login`")
    expect(execFailure({ exitCode: 2, stdout: "", stderr: "ERROR: Reconnecting... 1/5\nerror: model gpt-x does not exist\n" })).toBe("exited 2: error: model gpt-x does not exist")
  })
  test("verdicts decode; anything else is an error", () => {
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Verdict))
    expect(decode(JSON.stringify({ summary: "ok", findings: [{ file: "a.ts", line: null, title: "x", failureScenario: "y" }] })).findings).toHaveLength(1)
    expect(() => decode("Sorry, I could not review this.")).toThrow()
    expect(() => decode(JSON.stringify({ summary: "ok" }))).toThrow()
  })
  test("scratch a killed daemon left is swept once stale; a review running now, and anything else, stays", async () => {
    const tmp = scratchDir("bt-sweep-")
    const made = (name: string, hoursAgo: number) => {
      const path = join(tmp, name)
      mkdirSync(path)
      writeFileSync(join(path, "verdict.json"), "{}")
      const at = new Date(Date.now() - hoursAgo * 3_600_000)
      utimesSync(path, at, at)
      return path
    }
    const killed = made("bt-review-killed", 30)
    const running = made("bt-review-running", 0.2)
    const other = made("bt-wt-other", 30)
    await Effect.runPromise(sweepReviewSandboxes(tmp, Date.now()))
    expect([existsSync(killed), existsSync(running), existsSync(other)]).toEqual([false, true, true])
  })
})
