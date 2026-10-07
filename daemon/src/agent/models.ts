import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Context, Effect, Layer, Schema } from "effect"
import type { Env } from "../config.ts"
import { InvalidInput } from "../domain/errors.ts"
import type { ModelCatalog, ModelSelection, ProviderCatalog } from "../domain/models.ts"
import { claudeExecutable } from "./agent.ts"
import { linkCodexAuth } from "./codex-home.ts"
import { CodexRpc } from "./codex-rpc.ts"

export interface ModelsShape {
  readonly catalog: (refresh?: boolean) => Effect.Effect<ModelCatalog>
  readonly validate: (selection: ModelSelection) => Effect.Effect<void, InvalidInput>
}
export class Models extends Context.Service<Models, ModelsShape>()("Models") {}
const CodexPage = Schema.Struct({ data: Schema.Array(Schema.Struct({ model: Schema.String, displayName: Schema.String, supportedReasoningEfforts: Schema.Array(Schema.Struct({ reasoningEffort: Schema.String })), defaultReasoningEffort: Schema.String, isDefault: Schema.Boolean })), nextCursor: Schema.NullOr(Schema.String) })

export const discoverCodex = async (codexPath: string | undefined, signal: AbortSignal): Promise<ProviderCatalog> => {
  const executable = codexPath ?? Bun.which("codex")
  if (!executable) throw new Error("Codex is not installed (or set BRIDGETOWN_CODEX_PATH).")
  const dir = await mkdtemp(join(tmpdir(), "bt-models-"))
  let rpc: CodexRpc | undefined
  try {
    linkCodexAuth(dir)
    rpc = new CodexRpc([executable, "app-server", "--listen", "stdio://"], signal, { CODEX_HOME: dir }, dir)
    await rpc.initialize()
    const models: Array<ProviderCatalog["models"][number]> = []
    let cursor: string | null = null
    do {
      const page = Schema.decodeUnknownSync(CodexPage)(await rpc.request("model/list", { limit: 100, ...(cursor === null ? {} : { cursor }) }))
      models.push(...page.data.map((m) => ({ id: m.model, name: m.displayName, efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort, isDefault: m.isDefault })))
      cursor = page.nextCursor
    } while (cursor !== null)
    return { provider: "codex", models, error: null }
  } finally { rpc?.close(); await rm(dir, { recursive: true, force: true }) }
}

export const discoverClaude = async (claudePath: string | undefined, abort: AbortController): Promise<ProviderCatalog> => {
  async function* noInput(): AsyncGenerator<SDKUserMessage> {
    if (!abort.signal.aborted) await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }))
  }
  const executable = claudeExecutable(claudePath)
  const session = query({ prompt: noInput(), options: { tools: [], disallowedTools: ["Task", "Agent"], mcpServers: {}, strictMcpConfig: true, settingSources: [], persistSession: false, abortController: abort,
    ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }) } })
  try {
    const models = await session.supportedModels()
    const unique = new Map<string, ProviderCatalog["models"][number]>()
    for (const [i, m] of models.entries()) {
      const id = m.resolvedModel ?? m.value
      unique.set(id, { id, name: m.displayName, efforts: m.supportsEffort === false ? [] : m.supportedEffortLevels ?? [], defaultEffort: null, isDefault: i === 0 || unique.get(id)?.isDefault === true })
    }
    return { provider: "claude", error: null, models: [...unique.values()] }
  } finally { abort.abort(); session.close() }
}

export const validateModelSelection = (selection: ModelSelection, catalog: ModelCatalog): string | undefined => {
  if (selection.mode === "automatic" || selection.effort === null) return undefined
  const model = catalog.providers.find((p) => p.provider === selection.provider)?.models.find((m) => m.id === selection.model)
  if (model !== undefined && !model.efforts.includes(selection.effort)) return `${model.name} does not support ${selection.effort} effort.`
  return undefined
}

export const ModelsLive = (env: Pick<Env, "claudePath" | "codexPath">) => {
  let cached: { at: number; value: ModelCatalog } | undefined
  let pending: Promise<ModelCatalog> | undefined
  const catalog = (refresh = false): Effect.Effect<ModelCatalog> => Effect.promise(async () => {
    if (!refresh && cached !== undefined && Date.now() - cached.at < 300_000) return cached.value
    if (pending !== undefined) return pending
    const discover = async (provider: "claude" | "codex"): Promise<ProviderCatalog> => {
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 10_000)
      try { return await (provider === "claude" ? discoverClaude(env.claudePath, abort) : discoverCodex(env.codexPath, abort.signal)) }
      catch (cause) { return { provider, models: [], error: cause instanceof Error ? cause.message : String(cause) } }
      finally { clearTimeout(timer) }
    }
    pending = Promise.all([discover("claude"), discover("codex")]).then((providers) => ({ providers }))
    try { const value = await pending; cached = { at: Date.now(), value }; return value }
    finally { pending = undefined }
  })
  return Layer.succeed(Models)({ catalog, validate: (selection) => selection.mode === "automatic" || selection.effort === null ? Effect.void : catalog().pipe(Effect.flatMap((value) => {
    const message = validateModelSelection(selection, value)
    return message === undefined ? Effect.void : Effect.fail(new InvalidInput({ message }))
  })) })
}
