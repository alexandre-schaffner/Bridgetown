/**
 * The daemon binary's entry. `--guard-exec` is the exec-time guard that the shims on a
 * session's PATH run before every gh, git, kubectl… (guard/exec.ts). It runs on every
 * git call, so it loads the guard alone. Anything else is the daemon.
 */
if (process.argv[2] === "--guard-exec") {
  const { guardExecMain } = await import("./guard/exec.ts")
  guardExecMain(process.argv.slice(3))
} else if (process.argv[2] === "--guard-codex") {
  const { codexHookVerdict } = await import("./guard/codex.ts")
  const { readScript } = await import("./guard/bash.ts")
  const [port = "0", branch = "", worktree = ""] = process.argv.slice(3)
  let raw: unknown
  try { raw = JSON.parse(await new Response(Bun.stdin.stream()).text()) } catch { raw = null }
  process.stdout.write(JSON.stringify(codexHookVerdict(raw, { daemonPort: Number(port), branch, cwd: worktree, worktree, readFile: readScript })))
} else {
  await import("./daemon.ts")
}
