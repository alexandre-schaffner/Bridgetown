import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import type { AgentRequest } from "./protocol.ts"
import { repoMcpServers } from "./options.ts"

export const codexUserHome = (): string => process.env.CODEX_HOME ?? join(homedir(), ".codex")

/** Isolated configuration; the login stays in Codex's own file, never copied into the daemon store. */
export const linkCodexAuth = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const auth = join(dir, "auth.json")
  if (!existsSync(auth) && existsSync(join(codexUserHome(), "auth.json"))) symlinkSync(join(codexUserHome(), "auth.json"), auth)
}

export const codexSessionHome = (home: string, id: string): string => join(home, "codex", encodeURIComponent(id))
const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

export const codexHookCommand = (request: AgentRequest): string => {
  const runner = import.meta.url.includes("$bunfs") ? [process.execPath] : [process.execPath, fileURLToPath(new URL("../main.ts", import.meta.url))]
  const command = [...runner, "--guard-codex", String(request.daemonPort), request.session.branch ?? "", request.session.worktree ?? ""].map(quote).join(" ")
  // As with the exec shims, repository preloads and environment must not reach the guard.
  return `cd / && exec /usr/bin/env -i PATH=${quote(process.env.PATH ?? "/usr/bin:/bin")} ${command}`
}

const LoadedGuards = Schema.Struct({
  features: Schema.Struct({ hooks: Schema.Boolean }),
  hooks: Schema.Struct({ PreToolUse: Schema.Array(Schema.Struct({
    matcher: Schema.optional(Schema.NullOr(Schema.String)),
    hooks: Schema.Array(Schema.Struct({ type: Schema.String, command: Schema.String, async: Schema.optional(Schema.Boolean) })),
  })) }),
})

/** A supported feature flag alone is insufficient: the actual synchronous guard must be loaded. */
export const hasCodexGuards = (config: unknown, request: AgentRequest): boolean => {
  const decoded = Schema.decodeUnknownOption(LoadedGuards)(config)
  if (decoded._tag === "None" || !decoded.value.features.hooks) return false
  return decoded.value.hooks.PreToolUse.some((entry) => entry.matcher == null && entry.hooks.some((hook) =>
    hook.type === "command" && hook.command === codexHookCommand(request) && hook.async !== true))
}

export const prepareCodexHome = (request: AgentRequest): string => {
  const dir = request.session.agentConfigDir ?? codexSessionHome(request.home, request.session.id)
  linkCodexAuth(dir)
  if (!existsSync(join(dir, "auth.json"))) throw new Error(`Codex login is unavailable. Run CODEX_HOME=${quote(dir)} codex login, then retry.`)
  const config = [
    'cli_auth_credentials_store = "file"',
    ...Object.entries(repoMcpServers(request.session.repoPath)).flatMap(([name, server]) => server.type === "http"
      ? [`[mcp_servers.${JSON.stringify(name)}]`, `url = ${JSON.stringify(server.url)}`] : []),
    `[projects.${JSON.stringify(request.session.worktree ?? request.session.repoPath)}]`, 'trust_level = "untrusted"',
    ...(request.session.worktree === request.session.repoPath ? [] : [`[projects.${JSON.stringify(request.session.repoPath)}]`, 'trust_level = "untrusted"']),
    '[features]', 'hooks = true', 'multi_agent = false', 'multi_agent_v2 = false',
    'code_mode = false', 'code_mode_only = false', 'unified_exec = false', 'shell_snapshot = false',
    '[hooks]', '[[hooks.PreToolUse]]', '[[hooks.PreToolUse.hooks]]',
    'type = "command"', `command = ${JSON.stringify(codexHookCommand(request))}`, 'timeout = 10',
  ].join("\n") + "\n"
  const path = join(dir, "config.toml")
  if (!existsSync(path) || readFileSync(path, "utf8") !== config) writeFileSync(path, config, { mode: 0o600 })
  return dir
}
