import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { makeBroker } from "../../src/security/broker.ts"
import { fileBroker, readBroker, readCommitBroker } from "../../src/security/files.ts"
import { runOk } from "../../src/lib/proc.ts"
import type { AgentRequest } from "../../src/agent/protocol.ts"
import { newSession } from "../../src/sessions/new-session.ts"
import { GH_HOST, GHE_REPO } from "../../src/config.ts"
import { makeAlert } from "../support/records.ts"
import { commit, scratchRepo, sh } from "../support/repo.ts"
import { scratchDir } from "../support/tmp.ts"

describe.skipIf(process.platform !== "darwin")("real scoped file broker", () => {
  test("reads, lists and writes in a separate worktree while refusing host files and credential aliases", async () => {
    const root = scratchDir("bt-file-broker-"), outside = scratchDir("bt-file-outside-")
    const signal = new AbortController().signal
    writeFileSync(join(root, "source.txt"), "hello")
    writeFileSync(join(outside, "private.txt"), "private-canary")
    symlinkSync(outside, join(root, "escape"))
    expect(await readBroker(root, { tool: "read_file", args: { path: "source.txt" } }, signal)).toContain("hello")
    expect(await readBroker(root, { tool: "list_files", args: {} }, signal)).toContain("source.txt")
    const content = "apostrophe ' and shell $(touch escaped) `commands`\n"
    await fileBroker(root, { tool: "write_file", args: { path: "nested/new.txt", content } }, signal)
    expect(readFileSync(join(root, "nested/new.txt"), "utf8")).toBe(content)
    await expect(readBroker(root, { tool: "read_file", args: { path: "escape/private.txt" } }, signal)).rejects.toThrow()
    await expect(fileBroker(root, { tool: "write_file", args: { path: "escape/change", content: "unsafe" } }, signal)).rejects.toThrow()
    await expect(readBroker(root, { tool: "run", args: { command: "true" } }, signal)).rejects.toThrow()
    mkdirSync(join(root, ".config"));writeFileSync(join(root, ".config", "auth"), "private-canary")
    symlinkSync(join(root, ".config", "auth"), join(root, "alias"))
    await expect(readBroker(root, { tool: "read_file", args: { path: "alias" } }, signal)).rejects.toThrow()
  }, 30_000)
})

const setup = () => {
  const repo = scratchRepo(), root = join(repo, ".shared", "worktrees", "fix-bt-test-123")
  sh(`git worktree add -q -b fix-bt-test-123 ${root}`, repo)
  sh('git config user.email t@t && git config user.name test', repo)
  const request: AgentRequest = {
    session: { ...newSession(makeAlert(), "s", repo, { mode: "manual", provider: "codex", model: "test", effort: null }), branch: "fix-bt-test-123", worktree: root },
    abort: new AbortController(), home: repo, daemonPort: 0, resume: false,
    prompt: { async *[Symbol.asyncIterator]() {} }, tools: { report: async () => {}, ask: async () => undefined, slackContext: async () => "", memorySearch: async () => "", memoryRead: async () => "", memoryRemember: async () => false }, onRefused: () => {}, onUndelivered: async () => {},
  }
  return { repo, root, request }
}

describe.skipIf(process.platform !== "darwin")("fix publication with a local fake remote", () => {
  test("commits scanned bytes despite late working-file mutation, restores draft before push and pins destination/ref", async () => {
    const { root, request } = setup()
    writeFileSync(join(root, "fix.txt"), "approved\n")
    const calls: Array<ReadonlyArray<string>> = []
    const pr = `https://${GH_HOST}/${GHE_REPO}/pull/12`
    const broker = makeBroker(request, async (command, options) => {
      calls.push(command)
      if (command[0] === "gh") {
        if (command.includes("list")) return JSON.stringify([{ url: pr, headRefName: request.session.branch, isDraft: false }])
        expect(command).toContain("--repo");expect(command).toContain(`${GH_HOST}/${GHE_REPO}`)
        return ""
      }
      if (command.includes("hash-object")) writeFileSync(join(root, "fix.txt"), "xoxp-late-private-token\n")
      if (command.includes("push")) {
        expect(command).toContain(`https://${GH_HOST}/${GHE_REPO}.git`)
        expect(command.at(-1)).toMatch(/^[0-9a-f]{40}:refs\/heads\/fix-bt-test-123$/)
        return Effect.runPromise(runOk([...command.slice(0, -2), "origin", command.at(-1) ?? ""], options))
      }
      return Effect.runPromise(runOk(command, options))
    })
    expect(await broker({ tool: "submit_fix", args: { title: "fix: safe bytes", body: "verified" } })).toBe(pr)
    expect(sh('git show HEAD:fix.txt', root)).toBe("approved")
    expect(sh('git show origin/fix-bt-test-123:fix.txt', root)).toBe("approved")
    expect(calls.findIndex((args) => args.includes("--undo"))).toBeLessThan(calls.findIndex((args) => args.includes("push")))
    expect(calls.some((args) => args.includes("add"))).toBe(false)
  }, 30_000)

  test("prepares a broker-owned follow-up from main after a merged fix", async () => {
    const { root, request } = setup()
    const merged = { ...request, session: { ...request.session, milestones: { ...request.session.milestones, merged: true } } }
    const broker = makeBroker(merged)
    expect(await broker({ tool: "list_files", args: {} })).toContain("Source file list")
    expect(sh("git branch --show-current", root)).toBe("fix-bt-test-123-2")
    expect(sh("git rev-parse HEAD", root)).toBe(sh("git rev-parse origin/main", root))
  }, 30_000)

  test("retry reuses an in-progress follow-up and a later merged follow-up advances the branch", async () => {
    const { root, request } = setup()
    const merged = { ...request, session: { ...request.session, milestones: { ...request.session.milestones, merged: true } } }
    await makeBroker(merged)({ tool: "write_file", args: { path: "new.txt", content: "pending" } })
    expect(await makeBroker(merged)({ tool: "read_file", args: { path: "new.txt" } })).toContain("pending")
    sh("git add new.txt", root);commit("follow-up", root)
    const later = { ...merged, session: { ...merged.session, prUrl: `https://${GH_HOST}/${GHE_REPO}/pull/12` } }
    const broker = makeBroker(later, (command, options) => command[0] === "gh" ? Promise.resolve(JSON.stringify({ headRefName: "fix-bt-test-123-2" })) : Effect.runPromise(runOk(command, options)))
    await broker({ tool: "list_files", args: {} })
    expect(sh("git branch --show-current", root)).toBe("fix-bt-test-123-3")
  }, 30_000)

  test("follow-up checkout cannot execute ignored clean, smudge or process converters", async () => {
    const { repo, root, request } = setup()
    writeFileSync(join(root, "source.txt"), "before")
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=probe")
    writeFileSync(join(root, ".gitignore"), "node_modules/\n")
    sh("git add source.txt .gitattributes .gitignore", root);commit("source", root)
    sh("git push origin HEAD:main", root)
    sh("git fetch origin main && git reset --hard origin/main", repo)
    writeFileSync(join(repo, "source.txt"), "after")
    sh("git add source.txt", repo);commit("main advanced", repo)
    sh("git push origin main", repo)
    const marker = join(scratchDir("bt-followup-filter-"), "host-marker")
    mkdirSync(join(root, "node_modules"))
    writeFileSync(join(root, "node_modules", "converter.sh"), `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o700 })
    for (const kind of ["clean", "smudge", "process"]) sh(`git config filter.probe.${kind} ./node_modules/converter.sh`, root)
    sh("git config filter.probe.required true", root)
    utimesSync(join(root, "source.txt"), new Date(), new Date(Date.now() + 2000))
    const merged = { ...request, session: { ...request.session, milestones: { ...request.session.milestones, merged: true } } }
    await makeBroker(merged)({ tool: "list_files", args: {} })
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("after")
    expect(sh("git branch --show-current", root)).toBe("fix-bt-test-123-2")
  }, 30_000)

  test("history and reviewer reads use committed objects despite symlink replacements and configured text converters", async () => {
    const { root, request } = setup()
    mkdirSync(join(root, "src"));writeFileSync(join(root, "src", "tracked.txt"), "committed source")
    writeFileSync(join(root, ".gitattributes"), "*.txt diff=probe")
    sh("git add src .gitattributes", root);commit("source", root)
    const head = sh("git rev-parse HEAD", root)
    const outside = scratchDir("bt-history-outside-"), marker = join(outside, "converter-marker")
    writeFileSync(join(outside, "tracked.txt"), "host-plain-canary")
    sh(`git config diff.probe.textconv 'touch ${marker}'`, root)
    rmSync(join(root, "src"), { recursive: true });symlinkSync(outside, join(root, "src"))
    expect(await makeBroker(request)({ tool: "github", args: { operation: "blame", path: "src/tracked.txt" } })).toContain("committed source")
    expect(await readCommitBroker(root, head, { tool: "read_file", args: { path: "src/tracked.txt" } }, request.abort.signal)).toContain("committed source")
    expect(existsSync(marker)).toBe(false)
    await expect(makeBroker(request)({ tool: "github", args: { operation: "local_diff" } })).rejects.toThrow()
  }, 30_000)

  test("changed-file discovery never executes configured clean filters on the host", async () => {
    const { root, request } = setup()
    writeFileSync(join(root, "source.txt"), "before")
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=probe")
    writeFileSync(join(root, "converter.sh"), "#!/bin/sh\ncat\n", { mode: 0o700 })
    sh("git add source.txt .gitattributes converter.sh", root);commit("source", root)
    const marker = join(scratchDir("bt-clean-filter-"), "host-marker")
    sh(`git config filter.probe.clean '${root}/converter.sh'`, root)
    writeFileSync(join(root, "converter.sh"), `#!/bin/sh\ntouch ${marker}\ncat\n`)
    writeFileSync(join(root, "source.txt"), "safe fix")
    const diff = await makeBroker(request)({ tool: "github", args: { operation: "local_diff" } })
    expect(diff).toContain("safe fix")
    expect(existsSync(marker)).toBe(false)
  }, 30_000)

  test("refuses protected or credential-bearing changes before any GitHub request", async () => {
    const { root, request } = setup()
    let githubCalls = 0
    const broker = makeBroker(request, async (command, options) => {
      if (command[0] === "gh" || command.includes("push")) { githubCalls++;throw new Error("Unexpected network") }
      return Effect.runPromise(runOk(command, options))
    })
    writeFileSync(join(root, "leak.txt"), "xoxp-private-token")
    await expect(broker({ tool: "submit_fix", args: { title: "fix: refuse", body: "" } })).rejects.toThrow("Credential-like")
    writeFileSync(join(root, "leak.txt"), "safe")
    writeFileSync(join(root, "AGENTS.md"), "untrusted instructions")
    await expect(broker({ tool: "submit_fix", args: { title: "fix: refuse", body: "" } })).rejects.toThrow("protected")
    expect(githubCalls).toBe(0)
  }, 30_000)
})
