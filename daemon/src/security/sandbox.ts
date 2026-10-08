import { parse } from "shell-quote"
import { spawn } from "node:child_process"
import { mkdtempSync, realpathSync } from "node:fs"
import { rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { captureCommand } from "../lib/proc.ts"
import { CREDENTIAL_NAMES, PROTECTED_NAMES, MAX_COMMAND_MS, MAX_TOOL_BYTES } from "./policy.ts"

const SandboxRequest = Schema.Struct({ worktree: Schema.String, scratch: Schema.String, command: Schema.String, readOnly: Schema.optional(Schema.Boolean), trustedHelper: Schema.optional(Schema.Boolean) })
export type SandboxRequest = typeof SandboxRequest.Type

/** No provider credentials, dotfiles, launch hooks or daemon configuration reach generated code. */
export const shellEnv = (scratch: string): Record<string, string> => ({
  PATH: `${dirname(realpathSync(Bun.which("bun") ?? process.execPath))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: scratch, TMPDIR: scratch, LANG: "en_US.UTF-8",
  BUN_CONFIG_NO_CLEAR_TERMINAL: "1",
})

export const sandboxPolicy = ({ worktree, scratch, readOnly, trustedHelper }: Pick<SandboxRequest, "worktree" | "scratch" | "readOnly" | "trustedHelper">): SandboxRuntimeConfig => {
  const sourceRoot = trustedHelper && !import.meta.url.includes("$bunfs") ? fileURLToPath(new URL("../../", import.meta.url)) : null
  const roots = sourceRoot === null ? [worktree] : [worktree, sourceRoot]
  return {
    network: { allowedDomains: [], deniedDomains: ["*"], allowLocalBinding: false, allowUnixSockets: [] },
    filesystem: {
      denyRead: ["/", ...roots.flatMap((root) => CREDENTIAL_NAMES.map((name) => `${root}/**/${name}`))],
      // Source-mode helpers need package resolution. This read grant is never given to generated commands.
      allowRead: ["/usr", "/bin", "/sbin", "/System", "/Library/Apple", "/Library/Developer", "/opt/homebrew", "/usr/local", "/private/etc", "/dev", worktree, scratch, realpathSync(process.execPath), realpathSync(Bun.which("bun") ?? process.execPath), ...(sourceRoot === null ? [] : [sourceRoot])],
      allowWrite: readOnly ? [scratch] : [worktree, scratch],
      denyWrite: roots.flatMap((root) => [...PROTECTED_NAMES, ".github/workflows"].map((name) => `${root}/**/${name}`)),
    },
  }
}

/** One runtime per command: its proxy and policy cannot leak between concurrent sessions. */
export const sandboxProgram = (): ReadonlyArray<string> =>
  import.meta.url.includes("$bunfs") ? [process.execPath] : [process.execPath, fileURLToPath(new URL("../main.ts", import.meta.url))]
export const sandboxCommand = (request: SandboxRequest): ReadonlyArray<string> => [...sandboxProgram(), "--sandbox-run", JSON.stringify(request)]

export interface SandboxResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string }

export const runSandboxed = async (worktree: string, command: string, signal: AbortSignal, options: { readonly readOnly?: boolean; readonly trustedHelper?: boolean; readonly stdin?: string } = {}): Promise<SandboxResult> => {
  if (signal.aborted) throw new Error("Investigation interrupted.")
  const scratch = mkdtempSync(join(dirname(realpathSync(worktree)), ".bt-sandbox-"))
  const argv = sandboxCommand({ worktree: realpathSync(worktree), scratch, command, readOnly: options.readOnly, trustedHelper: options.trustedHelper })
  const executable = argv[0]
  if (executable === undefined) throw new Error("Sandbox runner unavailable.")
  try {
    return await captureCommand(argv, { cwd: "/", env: shellEnv(scratch), timeoutMs: MAX_COMMAND_MS, maxOutputBytes: MAX_TOOL_BYTES, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) }, signal)
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

/** Trusted helper mode. It must never fall back to an unrestricted shell. */
export const sandboxRunMain = async (raw: string): Promise<void> => {
  const request = Schema.decodeUnknownSync(Schema.fromJsonString(SandboxRequest))(raw)
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime")
  if (process.platform !== "darwin") throw new Error("Bridgetown's investigation sandbox currently requires macOS.")
  if (!SandboxManager.isSupportedPlatform()) throw new Error("OS sandbox unavailable; command refused.")
  try {
    await SandboxManager.initialize(sandboxPolicy(request), async () => false, false)
    const wrapped = await SandboxManager.wrapWithSandboxArgv(request.command, "/bin/bash", undefined, undefined, request.worktree)
    // Pinned macOS runtime emits `env ... sandbox-exec -p PROFILE bash -c COMMAND`.
    // Decode that launcher, tighten credential IPC, then spawn argv without a host shell.
    const script = wrapped.argv[2]
    if (wrapped.argv[0] !== "/bin/bash" || wrapped.argv[1] !== "-c" || script === undefined) throw new Error("Unexpected sandbox launcher.")
    const parsed = parse(script)
    if (!parsed.every((part): part is string => typeof part === "string")) throw new Error("Sandbox launcher contains shell operators.")
    const at = parsed.indexOf("/usr/bin/sandbox-exec")
    const profile = parsed[at + 2]
    if (parsed[0] !== "env" || at < 1 || parsed[at + 1] !== "-p" || profile === undefined || !profile.startsWith("(version 1)\n") || !profile.includes("(deny default")) throw new Error("Unexpected macOS sandbox profile.")
    // Keychain IPC and shared-memory names must not provide an alternative credential or exfiltration route.
    parsed[at + 2] = `${profile}\n(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))\n(deny ipc-posix-shm)\n(deny ipc-posix-sem)`
    const child = spawn("/usr/bin/env", parsed.slice(1), { cwd: request.worktree, env: shellEnv(request.scratch), stdio: "inherit" })
    const code = await new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("exit", (code) => resolve(code ?? 1)) })
    process.exitCode = code
  } finally { await SandboxManager.reset() }
}
