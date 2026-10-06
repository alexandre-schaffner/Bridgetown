import { describe, expect, test } from "bun:test"
import { clock, escapeRegExp, firstLine, oneLine, pct, plural, truncate } from "../src/lib/text.ts"

describe("plain text helpers", () => {
  test("truncate keeps short text and ends long text with an ellipsis, never a space before it", () => {
    expect(truncate("short", 10)).toBe("short")
    expect(truncate("a long line of text", 8)).toBe("a long…")
  })
  test("oneLine flattens every run of whitespace, then truncates", () => {
    expect(oneLine("  Error:\n\tconnection  refused \n", 80)).toBe("Error: connection refused")
    expect(oneLine("Error:\nconnection refused", 10)).toBe("Error: co…")
  })
  test("firstLine is the first line with content, past blank lines and bare group pings", () => {
    expect(firstLine("\n\n  Build failed\nmore")).toBe("Build failed")
    expect(firstLine("<!subteam^S0AV28YJPG8>\n[FIRING:1] eRPC")).toBe("[FIRING:1] eRPC")
    expect(firstLine("")).toBe("")
  })
  test("pct, plural and clock", () => {
    expect(pct(0.873)).toBe("87%")
    expect(plural(1, "round", "rounds")).toBe("1 round")
    expect(plural(3, "round", "rounds")).toBe("3 rounds")
    expect(clock(new Date("2026-10-06T14:05:59.000Z"))).toBe("14:05 UTC")
  })
  test("escapeRegExp matches the text literally", () => {
    expect(new RegExp(`^${escapeRegExp("fix-bt-a.b(1)")}$`).test("fix-bt-a.b(1)")).toBe(true)
    expect(new RegExp(`^${escapeRegExp("a.b")}$`).test("axb")).toBe(false)
  })
})
