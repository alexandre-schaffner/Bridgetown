import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { evidenceRef, redact } from "../../src/memory/evidence.ts"
import { memoryPath, memoryRepository, recall, validateChanges, type Checkpoint, type MemorySnapshot } from "../../src/memory/repository.ts"
import { scratchDir } from "../support/tmp.ts"

const source = evidenceRef("preference")
const sources = new Map([[source, { category: "user statement" }]])
const entry = `- Prefers concise bullet-point summaries [source: ${source}; added: 2026-10-07; evidence: user statement]`
const index = "# Memory\n\n## Index\n- [[preferences]]\n"
const before: MemorySnapshot = { head: "head", files: { "MEMORY.md": "# Memory\n\n## Index\n" } }

describe("the memory wiki", () => {
  test("rejects traversal, symlinks, unsupported sources, broken links and evidence upgrades", () => {
    const root = scratchDir("bt-memory-path-")
    const outside = scratchDir("bt-memory-outside-")
    symlinkSync(outside, join(root, "topics"))
    for (const path of ["../outside.md", "/absolute.md", ".git/config.md", "topics/a.md", "bad.sql"]) expect(() => memoryPath(root, path)).toThrow()
    expect(() => validateChanges(before, { changes: [{ path: "preferences.md", content: "- unsupported" }] }, sources)).toThrow()
    expect(() => validateChanges(before, { changes: [{ path: "MEMORY.md", content: index }] }, sources)).toThrow("Broken memory link")
    expect(() => validateChanges(before, { changes: [{ path: "preferences.md", content: entry.replace("user statement", "observed workflow") }] }, sources)).toThrow()
    expect(() => validateChanges(before, { changes: [{ path: "MEMORY.md", content: null }] }, sources)).toThrow()
  })

  test("commits only validated files, records checkpoint IDs, reads dirty edits and refuses to overwrite them", async () => {
    const root = join(scratchDir("bt-memory-git-"), "memory")
    const repo = memoryRepository(root)
    const snapshot = await Effect.runPromise(repo.snapshot)
    await Effect.runPromise(repo.apply(snapshot, { changes: [{ path: "MEMORY.md", content: index }, { path: "preferences.md", content: entry }] },
      { mode: "learn", events: ["preference"], at: "2026-10-07T10:00:00.000Z", input: "" }, sources))
    expect((await Effect.runPromise(repo.history()))[0]?.checkpoint.events).toEqual(["preference"])
    const learned = await Effect.runPromise(repo.snapshot)
    expect(recall(learned, "concise")).toContain(entry)
    expect(recall(learned, "concise", 100).length).toBeLessThanOrEqual(100)
    writeFileSync(join(root, "preferences.md"), entry.replace("concise", "detailed"))
    expect(recall(await Effect.runPromise(repo.snapshot), "detailed")).toContain("detailed")
    await expect(Effect.runPromise(repo.apply(learned, { changes: [] }, { mode: "dream", events: [], at: "now", input: "head" }, sources))).rejects.toThrow("uncommitted")
    expect(readFileSync(join(root, "preferences.md"), "utf8")).toContain("detailed")
  })

  test("UTF-8 limits reject oversized proposals before any files change and accept the byte boundary", async () => {
    const repo = memoryRepository(join(scratchDir("bt-memory-utf8-"), "memory"))
    const checkpoint = { mode: "learn", events: ["preference"], at: "2026-10-08T10:00:00.000Z", input: "" } satisfies Checkpoint
    for (const [path, limit] of [["MEMORY.md", 4_096], ["preferences.md", 16_384]] satisfies Array<[string, number]>) {
      const snapshot = await Effect.runPromise(repo.snapshot)
      const suffix = ` [source: ${source}; added: 2026-10-07; evidence: user statement]`
      const remaining = limit - Buffer.byteLength(`- ${suffix}`, "utf8")
      const fact = `- ${"é".repeat(Math.floor(remaining / 2))}${"x".repeat(remaining % 2)}`
      const content = `${fact}${suffix}`
      expect(Buffer.byteLength(content, "utf8")).toBe(limit)
      const oversized = { changes: [{ path, content: `${fact}é${suffix}` }] }
      expect(oversized.changes[0]?.content.length).toBeLessThan(limit)
      await expect(Effect.runPromise(repo.apply(snapshot, oversized, checkpoint, sources))).rejects.toThrow("too large")
      expect(await Effect.runPromise(repo.snapshot)).toEqual(snapshot)
      await Effect.runPromise(repo.clean)
      await Effect.runPromise(repo.apply(snapshot, { changes: [{ path, content }] }, checkpoint, sources))
      expect((await Effect.runPromise(repo.snapshot)).files[path]).toBe(content)
      await Effect.runPromise(repo.clean)
    }
  })

  test("UTF-8 limits include the original source attribution before writing", async () => {
    const repo = memoryRepository(join(scratchDir("bt-memory-origin-utf8-"), "memory"))
    const snapshot = await Effect.runPromise(repo.snapshot)
    const content = entry.replace("Prefers concise bullet-point summaries", "é".repeat(1_600))
    const supported = new Map([[source, { category: "user statement", origin: `https://example.com/${"é".repeat(500)}` }]])
    await expect(Effect.runPromise(repo.apply(snapshot, { changes: [{ path: "MEMORY.md", content }] },
      { mode: "learn", events: ["preference"], at: "2026-10-08T10:00:00.000Z", input: "" }, supported))).rejects.toThrow("too large after source attribution")
    expect(await Effect.runPromise(repo.snapshot)).toEqual(snapshot)
    await Effect.runPromise(repo.clean)
  })

  test("does not replace a non-empty directory or a foreign Git worktree", async () => {
    const root = scratchDir("bt-memory-existing-")
    writeFileSync(join(root, "keep.txt"), "keep")
    await expect(Effect.runPromise(memoryRepository(root).snapshot)).rejects.toThrow("non-empty")
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("keep")
    mkdirSync(join(root, "child"))
    symlinkSync(root, join(root, "child", "memory"))
    await expect(Effect.runPromise(memoryRepository(join(root, "child", "memory")).snapshot)).rejects.toThrow("symlink")
  })

  test("consolidation can merge topics, replace contradicted facts and repair links in one commit", async () => {
    const root = join(scratchDir("bt-memory-merge-"), "memory")
    const repo = memoryRepository(root)
    const oldSource = evidenceRef("old-owner")
    const newSource = evidenceRef("new-owner")
    const oldFact = `- Priya owns billing [source: ${oldSource}; added: 2026-10-01; evidence: user statement]`
    const newFact = `- Bob now owns billing [source: ${newSource}; added: 2026-10-07; evidence: user statement]`
    const supported = new Map([[oldSource, { category: "user statement" }], [newSource, { category: "user statement" }]])
    await Effect.runPromise(repo.apply(await Effect.runPromise(repo.snapshot), { changes: [
      { path: "MEMORY.md", content: "# Memory\n\n## Index\n- [[billing]]\n- [[owners]]\n" },
      { path: "billing.md", content: oldFact }, { path: "owners.md", content: oldFact },
    ] }, { mode: "learn", events: ["old-owner"], at: "2026-10-01T00:00:00Z", input: "" }, supported))
    const original = await Effect.runPromise(repo.snapshot)
    await Effect.runPromise(repo.apply(original, { changes: [
      { path: "MEMORY.md", content: "# Memory\n\n## Index\n- [[billing]]\n" },
      { path: "billing.md", content: newFact }, { path: "owners.md", content: null },
    ] }, { mode: "dream", events: [], at: "2026-10-07T00:00:00Z", input: original.head }, supported))
    const consolidated = await Effect.runPromise(repo.snapshot)
    expect(consolidated.files["owners.md"]).toBeUndefined()
    expect(recall(consolidated, "billing")).toContain("Bob now owns")
    expect(recall(consolidated, "billing")).not.toContain("Priya")
    await Effect.runPromise(repo.clean)
  })

  test("missing Git falls back to no recalled context without interrupting the daemon", async () => {
    const home = scratchDir("bt-memory-no-git-")
    const sourceRoot = join(import.meta.dir, "../..")
    const code = `import { Effect, Schema } from ${JSON.stringify(join(sourceRoot, "node_modules/effect/dist/index.js"))};
      import { Memory } from ${JSON.stringify(join(sourceRoot, "src/memory/memory.ts"))};
      import { makeWorld } from ${JSON.stringify(join(sourceRoot, "test/support/world.ts"))};
      const world = makeWorld({home: process.argv[1]});
      try { console.log(JSON.stringify(await world.runPromise(Effect.gen(function*(){
        const memory = yield* Memory; const context = yield* memory.context("billing");
        return {context, status: yield* memory.status};
      })))); } finally { await world.dispose(); }`
    const child = Bun.spawn([process.execPath, "--eval", code, home], { env: { ...process.env, PATH: "/missing-git" }, stdout: "pipe", stderr: "pipe" })
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(status, stderr).toBe(0)
    const result = Schema.decodeUnknownSync(Schema.Struct({ context: Schema.String, status: Schema.Struct({ state: Schema.String, error: Schema.String }) }))(JSON.parse(stdout))
    expect(result.context).toBe("")
    expect(result.status.state).toBe("error")
    expect(result.status.error).toContain("git")
  })

  test("redacts launch credentials, Slack/API tokens and private keys", () => {
    const text = "launch-secret xoxp-123456789-abcdefgh sk-ant-123456789abcdefgh password=hunter2\n-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----"
    const cleaned = redact(text, ["launch-secret"])
    for (const secret of ["launch-secret", "xoxp-", "sk-ant-", "hunter2", "\nprivate\n"]) expect(cleaned).not.toContain(secret)
  })

  test("redacts quoted JSON fields, escaped values and nested encoded messages", () => {
    const credentials = { password: 'hunter"2\\secret', api_key: "generic-service-key", authorization: "Bearer generic-token" }
    const raw = JSON.stringify(credentials)
    expect(JSON.parse(redact(raw))).toEqual({ password: "[redacted]", api_key: "[redacted]", authorization: "[redacted]" })
    for (const input of [raw, `Config: ${raw}`, JSON.stringify({ raw }), JSON.stringify({ events: [{ text: JSON.stringify({ raw }) }] })]) {
      const clean = redact(input)
      for (const secret of ["hunter", "generic-service-key", "generic-token"]) expect(clean).not.toContain(secret)
      expect(redact(clean)).toBe(clean)
    }
    const safe = '{ "raw": "A useful message", "count": 2 }'
    expect(redact(safe)).toBe(safe)
  })
})
