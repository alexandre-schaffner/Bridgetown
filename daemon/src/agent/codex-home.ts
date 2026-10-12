import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import type { CodexRequest } from "./protocol.ts"

export const codexUserHome = (): string => process.env.CODEX_HOME ?? join(homedir(), ".codex")

/** Isolated configuration; the login stays in Codex's own file, never copied into the daemon store. */
export const linkCodexAuth = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const auth = join(dir, "auth.json")
  if (!existsSync(auth) && existsSync(join(codexUserHome(), "auth.json"))) symlinkSync(join(codexUserHome(), "auth.json"), auth)
}

/** Installed plugins live in Codex's home; an investigation uses the user's rather than installing its own. */
const linkCodexPlugins = (dir: string): void => {
  const plugins = join(dir, "plugins")
  if (!existsSync(plugins) && existsSync(join(codexUserHome(), "plugins"))) symlinkSync(join(codexUserHome(), "plugins"), plugins)
}

const UserConfig = Schema.Struct({
  mcp_servers: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
  plugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  marketplaces: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  apps: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

/**
 * The user's own tools, as thread configuration: their MCP servers, plugins and ChatGPT apps. Nobody is there to
 * approve a call, so every tool runs without a prompt and the guard hook decides. Hooks, projects and the rest of
 * the user's configuration stay out.
 */
export const inheritedCodexConfig = (home = codexUserHome()): Record<string, unknown> => {
  let raw: unknown
  try { raw = Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8")) } catch { return {} }
  const user = Schema.decodeUnknownOption(UserConfig)(raw)
  if (user._tag === "None") return {}
  const { mcp_servers = {}, plugins, marketplaces, apps = {} } = user.value
  // A relative `cwd` is relative to the user's Codex home, not the session's.
  const servers = Object.fromEntries(Object.entries(mcp_servers).map(([name, server]) => [name, {
    ...server, ...(typeof server.cwd === "string" ? { cwd: resolve(home, server.cwd) } : {}), default_tools_approval_mode: "approve",
  }]))
  const defaults = typeof apps._default === "object" && apps._default !== null ? apps._default : {}
  return {
    mcp_servers: servers,
    ...(plugins === undefined ? {} : { plugins }),
    ...(marketplaces === undefined ? {} : { marketplaces }),
    apps: { ...apps, _default: { enabled: true, ...defaults, default_tools_approval_mode: "approve" } },
  }
}

export const codexSessionHome = (home: string, id: string): string => join(home, "codex", encodeURIComponent(id))
const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

/** `inherit` lets the user's own MCP tools through; built-in shell and files are refused either way. */
export const codexHookCommand = (inherit = false): string => {
  const runner = import.meta.url.includes("$bunfs") ? [process.execPath] : [process.execPath, fileURLToPath(new URL("../main.ts", import.meta.url))]
  const command = [...runner, "--guard-codex", ...(inherit ? ["--inherit"] : [])].map(quote).join(" ")
  // Repository preloads and environment must not reach the trusted hook.
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
export const hasCodexGuards = (config: unknown, inherit = false): boolean => {
  const decoded = Schema.decodeUnknownOption(LoadedGuards)(config)
  if (decoded._tag === "None" || !decoded.value.features.hooks) return false
  return decoded.value.hooks.PreToolUse.some((entry) => entry.matcher == null && entry.hooks.some((hook) =>
    hook.type === "command" && hook.command === codexHookCommand(inherit) && hook.async !== true))
}

const HookList = Schema.Struct({ data: Schema.Array(Schema.Struct({ hooks: Schema.Array(Schema.Struct({
  key: Schema.String, eventName: Schema.String, handlerType: Schema.String, command: Schema.optional(Schema.String),
  matcher: Schema.NullOr(Schema.String), enabled: Schema.Boolean, currentHash: Schema.String, trustStatus: Schema.String,
})) })) })
type Rpc = { readonly request: (method: string, params: unknown) => Promise<unknown> }

/**
 * Codex runs only hooks whose hash is trusted, and `--dangerously-bypass-hook-trust` does not reach app-server
 * threads. Bridgetown trusts its own guard, and only that, then checks Codex will run it.
 */
export const trustCodexGuard = async (rpc: Rpc, cwd: string | null, inherit = false): Promise<void> => {
  const guards = async () => Schema.decodeUnknownSync(HookList)(await rpc.request("hooks/list", cwd === null ? {} : { cwds: [cwd] })).data
    .flatMap((entry) => entry.hooks)
    .filter((hook) => hook.eventName === "preToolUse" && hook.handlerType === "command" && hook.command === codexHookCommand(inherit) && hook.matcher === null && hook.enabled)
  const untrusted = (await guards()).filter((hook) => hook.trustStatus !== "trusted" && hook.trustStatus !== "managed")
  if (untrusted.length > 0) await rpc.request("config/batchWrite", {
    edits: [{ keyPath: "hooks.state", value: Object.fromEntries(untrusted.map((hook) => [hook.key, { trusted_hash: hook.currentHash }])), mergeStrategy: "upsert" }],
    reloadUserConfig: true,
  })
  const loaded = await guards()
  if (loaded.length === 0 || loaded.some((hook) => hook.trustStatus !== "trusted" && hook.trustStatus !== "managed")) throw new Error("Codex would not run Bridgetown's tool guard; the investigation was stopped.")
}

export const prepareCodexHome = (request: CodexRequest, inherit = false): string => {
  const dir = request.session.agentConfigDir ?? codexSessionHome(request.home, request.session.id)
  linkCodexAuth(dir)
  if (inherit) linkCodexPlugins(dir)
  if (!existsSync(join(dir, "auth.json"))) throw new Error(`Codex login is unavailable. Run CODEX_HOME=${quote(dir)} codex login, then retry.`)
  const config = [
    'cli_auth_credentials_store = "file"',
    `[projects.${JSON.stringify(request.session.worktree ?? request.session.repoPath)}]`, 'trust_level = "untrusted"',
    ...(request.session.worktree === request.session.repoPath ? [] : [`[projects.${JSON.stringify(request.session.repoPath)}]`, 'trust_level = "untrusted"']),
    '[features]', 'hooks = true', 'multi_agent = false', 'multi_agent_v2 = false',
    'code_mode = false', 'code_mode_only = false', 'shell_snapshot = false',
    '[hooks]', '[[hooks.PreToolUse]]', '[[hooks.PreToolUse.hooks]]',
    'type = "command"', `command = ${JSON.stringify(codexHookCommand(inherit))}`, 'timeout = 10',
  ].join("\n") + "\n"
  const path = join(dir, "config.toml")
  if (!existsSync(path) || readFileSync(path, "utf8") !== config) writeFileSync(path, config, { mode: 0o600 })
  return dir
}
