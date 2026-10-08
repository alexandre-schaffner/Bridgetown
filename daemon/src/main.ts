/** CLI helpers run independently of daemon startup and never load worktree hooks or credentials. */
if (process.argv[2] === "--sandbox-run") {
  try {
    const { sandboxRunMain } = await import("./security/sandbox.ts")
    await sandboxRunMain(process.argv[3] ?? "")
  } catch {
    console.error("Bridgetown's OS sandbox could not run this command. No unrestricted fallback was used.")
    process.exitCode = 126
  }
} else if (process.argv[2] === "--changed-files") {
  try {
    const { changedPathsMain } = await import("./security/changes.ts")
    await changedPathsMain()
  } catch { process.exitCode = 126 }
} else if (process.argv[2] === "--check-command") {
  try {
    const { commandPolicyMain } = await import("./security/commands.ts")
    commandPolicyMain(process.argv[3] ?? "")
  } catch { process.exitCode = 126 }
} else if (process.argv[2] === "--snapshot-files") {
  try {
    const { snapshotFilesMain } = await import("./security/files.ts")
    snapshotFilesMain(process.argv[3] ?? "")
  } catch { process.exitCode = 126 }
} else if (process.argv[2] === "--file-tool") {
  try {
    const { fileToolMain } = await import("./security/files.ts")
    fileToolMain(process.argv[3] ?? "")
  } catch { process.exitCode = 126 }
} else if (process.argv[2] === "--guard-exec") {
  console.error("The legacy exec guard has been replaced by the OS sandbox and broker.")
  process.exitCode = 126
} else if (process.argv[2] === "--guard-codex") {
  const { codexHookVerdict } = await import("./guard/codex.ts")
  let raw: unknown
  try { raw = JSON.parse(await new Response(Bun.stdin.stream()).text()) } catch { raw = null }
  process.stdout.write(JSON.stringify(codexHookVerdict(raw)))
} else {
  await import("./daemon.ts")
}
