import { Effect } from "effect"
import { type ModelsShape, validateModelSelection } from "../../src/agent/models.ts"
import { InvalidInput } from "../../src/domain/errors.ts"
import type { ModelCatalog } from "../../src/domain/models.ts"

export const MODEL_CATALOG: ModelCatalog = { providers: [
  { provider: "codex", error: null, models: [
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium", isDefault: true },
    { id: "gpt-6-astra", name: "GPT-6 Astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low", isDefault: false },
    { id: "gpt-6-sol", name: "GPT-6 Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium", isDefault: false },
    { id: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", isDefault: false },
  ] },
  { provider: "claude", error: null, models: [
    { id: "claude-opus-5-5", name: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null, isDefault: true },
    { id: "claude-fable-5-1", name: "Fable 5.1", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null, isDefault: false },
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null, isDefault: false },
    { id: "claude-haiku-5-5", name: "Haiku 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null, isDefault: false },
  ] },
] }

/** Discovery without installed CLIs, accounts or inference, for HTTP and native UI tests. */
export const fakeModels = (catalog: ModelCatalog = MODEL_CATALOG): ModelsShape => ({
  catalog: () => Effect.succeed(catalog),
  validate: (selection) => {
    const message = validateModelSelection(selection, catalog)
    return message === undefined ? Effect.void : Effect.fail(new InvalidInput({ message }))
  },
})
