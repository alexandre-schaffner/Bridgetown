import { Schema } from "effect"

export const AgentProvider = Schema.Literals(["claude", "codex"])
export type AgentProvider = typeof AgentProvider.Type
export const PROVIDER_NAMES: Readonly<Record<AgentProvider, string>> = { claude: "Claude Code", codex: "Codex" }
export const ClaudeEffort = Schema.Literals(["low", "medium", "high", "xhigh", "max"])
export type ClaudeEffort = typeof ClaudeEffort.Type
const Identifier = Schema.String.check(Schema.isPattern(/^\S(?:[^\r\n]*\S)?$/))
const Automatic = Schema.Struct({ mode: Schema.Literal("automatic") })
const Manual = { mode: Schema.Literal("manual"), model: Identifier }
export const ModelSelection = Schema.Union([
  Automatic,
  Schema.Struct({ ...Manual, provider: Schema.Literal("claude"), effort: Schema.NullOr(ClaudeEffort) }),
  Schema.Struct({ ...Manual, provider: Schema.Literal("codex"), effort: Schema.NullOr(Identifier) }),
])
export type ModelSelection = typeof ModelSelection.Type
export const ModelSettings = Schema.Struct({ monitoring: ModelSelection, reviewing: ModelSelection, memory: ModelSelection })
export type ModelSettings = typeof ModelSettings.Type
export const AUTOMATIC: ModelSelection = { mode: "automatic" }
export const DEFAULT_MODELS: ModelSettings = { monitoring: AUTOMATIC, reviewing: AUTOMATIC, memory: AUTOMATIC }

export const ModelInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  efforts: Schema.Array(Schema.String),
  defaultEffort: Schema.NullOr(Schema.String),
  isDefault: Schema.Boolean,
})
export type ModelInfo = typeof ModelInfo.Type
export const ProviderCatalog = Schema.Struct({
  provider: AgentProvider,
  models: Schema.Array(ModelInfo),
  error: Schema.NullOr(Schema.String),
})
export type ProviderCatalog = typeof ProviderCatalog.Type
export const ModelCatalog = Schema.Struct({ providers: Schema.Array(ProviderCatalog) })
export type ModelCatalog = typeof ModelCatalog.Type
