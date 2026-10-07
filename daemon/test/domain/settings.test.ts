import { describe, expect, test } from "bun:test"
import { DEFAULT_CHANNELS, DEFAULT_SETTINGS, loadSettings } from "../../src/domain/settings.ts"

describe("stored settings", () => {
  test("none stored: the defaults, every default channel on", () => {
    expect(loadSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_CHANNELS.every((c) => c.enabled)).toBe(true)
  })

  test("unreadable: the defaults", () => {
    expect(loadSettings("{not json")).toEqual(DEFAULT_SETTINGS)
  })

  test("stored before a default channel existed: toggles kept, the new channel listed but off", () => {
    const muted = { id: "C0AUKD42N3U", name: "alert-releases", enabled: false }
    const stored = { ...DEFAULT_SETTINGS, channels: [muted, ...DEFAULT_CHANNELS.slice(1, -1)] }
    const { channels } = loadSettings(JSON.stringify(stored))
    const added = DEFAULT_CHANNELS.at(-1)
    expect(channels).toHaveLength(DEFAULT_CHANNELS.length)
    expect(channels[0]).toEqual(muted)
    expect(channels.at(-1)).toEqual(added === undefined ? undefined : { ...added, enabled: false })
  })
})

describe("settings stored before a setting existed", () => {
  test("keep their values and take the new settings' defaults, however deep", () => {
    const { adversarialReview: _, ...old } = DEFAULT_SETTINGS
    const { findingReal: _r, findingBlocking: _b, findingRebutted: _x, ...oldThresholds } = DEFAULT_SETTINGS.thresholds
    const settings = loadSettings(JSON.stringify({ ...old, maxConcurrent: 3, thresholds: { ...oldThresholds, autoActionable: 0.7 } }))
    expect(settings).toMatchObject({ maxConcurrent: 3, adversarialReview: true, thresholds: { autoActionable: 0.7, findingReal: 0.6, findingBlocking: 0.5, findingRebutted: 0.6 } })
  })

  test("a nested setting missing a key keeps the rest of what was stored", () => {
    const settings = loadSettings(JSON.stringify({ ...DEFAULT_SETTINGS, maxConcurrent: 3, quietHours: { enabled: true, start: "23:00" } }))
    expect(settings).toMatchObject({ maxConcurrent: 3, quietHours: { enabled: true, start: "23:00", end: "08:00" } })
  })

  test("a poll stored before it had to be whole seconds reads as the loop runs it", () => {
    expect(loadSettings(JSON.stringify({ ...DEFAULT_SETTINGS, pollSeconds: 7.5 })).pollSeconds).toBe(10)
    expect(loadSettings(JSON.stringify({ ...DEFAULT_SETTINGS, pollSeconds: 42.6 })).pollSeconds).toBe(43)
  })

  test("a value out of range is unreadable: the defaults", () => {
    expect(loadSettings(JSON.stringify({ ...DEFAULT_SETTINGS, maxConcurrent: 0 }))).toEqual(DEFAULT_SETTINGS)
  })
})
