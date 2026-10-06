import { describe, expect, test } from "bun:test"
import { ownPrUrl } from "../../src/ship/pr.ts"

describe("the agent's PR link", () => {
  const OWN = "https://nocturlab.ghe.com/Merkl/monorepo/pull/3401"

  test("is the PR's own URL when it points into a PR on the repo Bridgetown ships", () => {
    for (const link of [OWN, `${OWN}/`, `${OWN}/files`, `${OWN}#issuecomment-1`, `${OWN}?w=1`]) expect(ownPrUrl(link)).toBe(OWN)
  })

  test("is no PR anywhere else", () => {
    for (const link of [
      "https://github.com/Merkl/monorepo/pull/3401",
      "https://nocturlab.ghe.com/Merkl/other/pull/1",
      "https://nocturlab.ghe.com/Merkl/monorepo/pull/3401x",
      "https://nocturlab.ghe.com/Merkl/monorepo/issues/3401",
      "https://nocturlab.ghe.com.evil.com/Merkl/monorepo/pull/1",
      "http://nocturlab.ghe.com/Merkl/monorepo/pull/1",
      null,
      undefined,
    ]) {
      expect(ownPrUrl(link)).toBeNull()
    }
  })
})
