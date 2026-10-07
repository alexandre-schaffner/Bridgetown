/**
 * The daemon binary's entry. `--guard-exec` is the exec-time guard that the shims on a
 * session's PATH run before every gh, git, kubectl… (guard/exec.ts). It runs on every
 * git call, so it loads the guard alone. Anything else is the daemon.
 */
if (process.argv[2] === "--guard-exec") {
  const { guardExecMain } = await import("./guard/exec.ts")
  guardExecMain(process.argv.slice(3))
} else {
  await import("./daemon.ts")
}
