import { describe, expect, test } from "bun:test"
import { tagPrefix } from "../../src/ship/tags.ts"

describe("release helpers", () => {
  test("tag prefix", () => {
    expect(tagPrefix("admin-v0.6.0")).toBe("admin")
    expect(tagPrefix("states-exporter-v0.1.0")).toBe("states-exporter")
    expect(tagPrefix("admin")).toBe("admin")
  })
})
