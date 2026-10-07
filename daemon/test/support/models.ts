import { Effect } from "effect"
import { type ModelsShape, validateModelSelection } from "../../src/agent/models.ts"
import { InvalidInput } from "../../src/domain/errors.ts"
import type { ModelCatalog } from "../../src/domain/models.ts"

export const MODEL_CATALOG: ModelCatalog = { providers: [
  { provider: "codex", error: null, models: [
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", isDefault: true },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium", isDefault: false },
  ] },
  { provider: "claude", error: null, models: [
    { id: "claude-sonnet-4-6", name: "Sonnet 4.6", efforts: ["low", "medium", "high"], defaultEffort: null, isDefault: true },
    { id: "claude-opus-4-6", name: "Opus 4.6", efforts: ["low", "medium", "high", "max"], defaultEffort: null, isDefault: false },
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
