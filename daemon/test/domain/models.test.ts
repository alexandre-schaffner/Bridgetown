import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Models, ModelsLive, validateModelSelection } from "../../src/agent/models.ts"
import { reviewerProfile } from "../../src/critique/reviewer.ts"
import { ModelSelection, type ModelCatalog } from "../../src/domain/models.ts"
import { DEFAULT_SETTINGS, loadSettings, mergeSettings, SettingsPatch } from "../../src/domain/settings.ts"
import { newSession } from "../../src/sessions/new-session.ts"
import { makeAlert } from "../support/records.ts"

const claude: ModelSelection = { mode: "manual", provider: "claude", model: "claude-opus-5-5", effort: "max" }
const codex: ModelSelection = { mode: "manual", provider: "codex", model: "gpt-6.1-sol", effort: "ultra" }
const catalog: ModelCatalog = { providers: [{ provider: "codex", error: null, models: [{ id: codex.model, name: "Sol", efforts: ["low", "high", "ultra"], defaultEffort: "low", isDefault: true }] }] }

describe("model configuration", () => {
  test("missing providers return actionable catalog errors and still allow explicit custom IDs", async () => {
    const catalog = await Effect.runPromise(Effect.gen(function* () {
      const models = yield* Models
      const value = yield* models.catalog()
      yield* models.validate(codex)
      return value
    }).pipe(Effect.provide(ModelsLive({ codexPath: "/nonexistent/codex", claudePath: "/nonexistent/claude" }))))
    expect(catalog.providers.map((p) => p.models)).toEqual([[], []])
    expect(catalog.providers.every((p) => p.error !== null && p.error.length > 0)).toBe(true)
  })
  test("old settings take Automatic while keeping all existing values", () => {
    const { models: _, ...old } = DEFAULT_SETTINGS
    expect(loadSettings(JSON.stringify({ ...old, maxConcurrent: 7 }))).toMatchObject({ maxConcurrent: 7, models: DEFAULT_SETTINGS.models })
  })
  test("role selections are atomic, independent, and survive persistence", async () => {
    const first = await Effect.runPromise(mergeSettings(DEFAULT_SETTINGS, { models: { monitoring: codex } }))
    const second = await Effect.runPromise(mergeSettings(first, { models: { reviewing: claude } }))
    expect(loadSettings(JSON.stringify(second)).models).toEqual({ monitoring: codex, reviewing: claude })
    const automatic = await Effect.runPromise(mergeSettings(second, { models: { monitoring: { mode: "automatic" } } }))
    expect(automatic.models).toEqual({ monitoring: { mode: "automatic" }, reviewing: claude })
    const defaultEffort = await Effect.runPromise(mergeSettings(second, { models: { monitoring: { ...codex, effort: null } } }))
    expect(defaultEffort.models.monitoring).toEqual({ ...codex, effort: null })
  })
  test("blank IDs, partial profiles, and unsupported Claude efforts are rejected", () => {
    for (const value of [{ ...codex, model: " " }, { mode: "manual", provider: "codex" }, { ...claude, effort: "ultra" }]) {
      expect(Schema.decodeUnknownOption(SettingsPatch)({ models: { monitoring: value } })._tag).toBe("None")
    }
    expect(validateModelSelection({ ...codex, effort: "max" }, catalog)).toContain("does not support")
    expect(validateModelSelection(codex, catalog)).toBeUndefined()
    expect(validateModelSelection({ ...codex, model: "custom-model", effort: "max" }, catalog)).toBeUndefined()
  })
  test("all investigation and review provider combinations resolve independently", () => {
    for (const monitoring of [claude, codex]) for (const reviewing of [claude, codex]) {
      const session = newSession(makeAlert(), "s", "/r", monitoring)
      expect(session).toMatchObject({ provider: monitoring.provider, model: monitoring.model, effort: monitoring.effort })
      expect(reviewerProfile(reviewing, "deep")).toEqual({ vendor: reviewing.provider, model: reviewing.model, effort: reviewing.effort })
    }
    expect(newSession(makeAlert(), "s", "/r").model).toBe("claude-opus-5-5")
    expect(reviewerProfile({ mode: "automatic" }, "deep")).toMatchObject({ vendor: "codex", effort: "xhigh" })
  })
})
