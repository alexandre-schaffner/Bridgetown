import { describe, expect, test } from "bun:test"
import { DEFAULT_CHANNELS, DEFAULT_SETTINGS } from "../src/config.ts"
import { loadSettings } from "../src/hub.ts"

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
