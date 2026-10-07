import { describe, expect, test } from "bun:test"
import { reviewRequestText, reviewRoute } from "../../src/ship/approvals.ts"
import { revvLink } from "../../src/ship/pr.ts"

describe("review routing", () => {
  test("product apps go to product-approvals with dev-product", () => {
    expect(reviewRoute("admin")).toEqual({ channelId: "C0ATZJNRU2J", channelName: "product-approvals", mention: "<!subteam^S0ATVUW9T7V|dev-product>" })
    expect(reviewRoute("merkl-admin").channelName).toBe("product-approvals")
    expect(reviewRoute("merkl-api").channelName).toBe("product-approvals")
  })
  test("everything else goes to general-approvals with its team", () => {
    expect(reviewRoute("states-exporter")).toMatchObject({ channelName: "general-approvals", mention: "<!subteam^S0ATLPMJECF|rd-team>" })
    expect(reviewRoute("merkl-states-exporter").mention).toBe("<!subteam^S0ATLPMJECF|rd-team>")
    expect(reviewRoute("merkl").mention).toBe("<!subteam^S0AU07798EA|engine-team>")
    expect(reviewRoute(null)).toMatchObject({ channelName: "general-approvals", mention: null })
  })
})

describe("revv", () => {
  test("deep link matches revv's builder", () => {
    expect(revvLink("https://nocturlab.ghe.com/Merkl/monorepo/pull/3340")).toBe(
      "revv://pr?host=nocturlab.ghe.com&repo=Merkl%2Fmonorepo&number=3340",
    )
    expect(revvLink("https://nocturlab.ghe.com/Merkl/monorepo/pull/3340/changes")).toBe(
      "revv://pr?host=nocturlab.ghe.com&repo=Merkl%2Fmonorepo&number=3340",
    )
    expect(revvLink("not a pr")).toBeNull()
  })
  test("request text", () => {
    const text = reviewRequestText({
      route: reviewRoute("admin"),
      prUrl: "https://nocturlab.ghe.com/Merkl/monorepo/pull/3340",
      prTitle: "fix(app-admin): pin vite to 6.3",
      summary: "vite 6.4 broke the admin build",
      alertTitle: "merkl-admin v0.6.0 · Build failed",
      alertPermalink: "https://merkl-adu1009.slack.com/archives/C0AUKD42N3U/p1790933006433649",
    })
    expect(text).toContain("<!subteam^S0ATVUW9T7V|dev-product> amp <https://nocturlab.ghe.com/Merkl/monorepo/pull/3340|#3340>")
    expect(text).toContain("revv://pr?host=nocturlab.ghe.com&repo=Merkl%2Fmonorepo&number=3340")
  })
})
