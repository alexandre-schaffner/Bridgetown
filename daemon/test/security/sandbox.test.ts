import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runSandboxed, shellEnv } from "../../src/security/sandbox.ts"
import { scratchDir } from "../support/tmp.ts"

test("generated code does not inherit credentials or execution overrides", () => {
  const env = shellEnv("/scratch")
  expect(env).not.toHaveProperty("ANTHROPIC_API_KEY")
  expect(env).not.toHaveProperty("SLACK_USER_TOKEN")
  expect(env).not.toHaveProperty("NODE_OPTIONS")
  expect(env).not.toHaveProperty("SSH_AUTH_SOCK")
})

describe.skipIf(process.platform !== "darwin")("real macOS sandbox", () => {
  test("generated commands cannot edit daemon memory outside the worktree, including through a symlink", async () => {
    const home = scratchDir("bt-memory-boundary-")
    const root = join(home, "worktree"), memory = join(home, "memory")
    mkdirSync(root);mkdirSync(memory)
    writeFileSync(join(memory, "MEMORY.md"), "trusted memory")
    symlinkSync(memory, join(root, "memory"))
    const result = await runSandboxed(root, `printf tampered > '${memory}/MEMORY.md'; printf tampered > memory/MEMORY.md`, new AbortController().signal)
    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe("trusted memory")
  }, 30_000)

  test("allows a local command and worktree writes", async () => {
    const root = scratchDir("bt-sandbox-test-")
    const result = await runSandboxed(root, "printf allowed > output.txt; printf ready", new AbortController().signal)
    expect(result).toMatchObject({ exitCode: 0, stdout: "ready" })
    expect(readFileSync(join(root, "output.txt"), "utf8")).toBe("allowed")
  }, 30_000)

  test("absolute-path programs and interpreted code cannot read outside or cross a symlink", async () => {
    const root = scratchDir("bt-sandbox-root-")
    const outside = scratchDir("bt-sandbox-secret-")
    writeFileSync(join(outside, "private.txt"), "private-canary")
    symlinkSync(outside, join(root, "outside"))
    const result = await runSandboxed(root, `/bin/cat '${outside}/private.txt'; /bin/cat outside/private.txt`, new AbortController().signal)
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).not.toContain("private-canary")
  }, 30_000)

  test("protects credentials and execution configuration inside the worktree", async () => {
    const root = scratchDir("bt-sandbox-protected-")
    writeFileSync(join(root, ".env"), "private-canary")
    writeFileSync(join(root, "AGENTS.md"), "trusted")
    mkdirSync(join(root, ".github", "workflows"), { recursive: true })
    const result = await runSandboxed(root, "/bin/cat .env; printf changed > AGENTS.md; printf unsafe > .github/workflows/escape.yml", new AbortController().signal)
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).not.toContain("private-canary")
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("trusted")
  }, 30_000)

  test("protects nested credential directories even from absolute binaries", async () => {
    const root = scratchDir("bt-credential-dirs-")
    for (const name of [".config", ".ssh", ".aws"]) { mkdirSync(join(root, name));writeFileSync(join(root, name, "auth"), "private-canary") }
    const result = await runSandboxed(root, "/bin/cat .config/auth; printf changed > .ssh/auth; printf changed > .aws/auth", new AbortController().signal)
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).not.toContain("private-canary")
    for (const name of [".ssh", ".aws"]) expect(readFileSync(join(root, name, "auth"), "utf8")).toBe("private-canary")
  }, 30_000)

  test("direct loopback network cannot bypass the proxy", async () => {
    let requests = 0
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { requests++; return new Response("received") } })
    try {
      const result = await runSandboxed(scratchDir("bt-sandbox-network-"), `/usr/bin/curl --noproxy '*' --max-time 2 http://127.0.0.1:${server.port}/exfil`, new AbortController().signal)
      expect(result.exitCode).not.toBe(0)
      expect(requests).toBe(0)
    } finally { server.stop(true) }
  }, 30_000)
})
