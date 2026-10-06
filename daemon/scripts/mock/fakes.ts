import { Duration, Effect } from "effect"
import type { ReviewerShape } from "../../src/critique/reviewer.ts"
import type { JevVerdict } from "../../src/domain/alert.ts"
import { GheBlocked, type GitHubError } from "../../src/domain/errors.ts"
import type { GitHubShape, PullRequest } from "../../src/ship/github.ts"
import { prLabel, prNumber } from "../../src/ship/pr.ts"
import { nextTagFrom } from "../../src/ship/tags.ts"
import type { SlackClientShape } from "../../src/slack/client.ts"
import type { JevShape } from "../../src/triage/jev.ts"

/** Slack that reads nothing new and swallows every post: the mock never reaches slack.com. */
export const fakeSlack: SlackClientShape = {
  identity: () => Effect.succeed({ user_id: "U03ALEX", user: "alex", url: "https://merkl.slack.com/" }),
  latest: () => Effect.succeed([]),
  replies: () => Effect.succeed([]),
  permalink: (channel, ts) => Effect.succeed(`https://merkl.slack.com/archives/${channel}/p${ts.replace(".", "")}`),
  search: () => Effect.succeed([]),
  groupsOf: () => Effect.succeed([]),
  userName: (id) => Effect.succeed(id),
  post: () => Effect.sync(() => (Date.now() / 1000).toFixed(6)),
  remove: () => Effect.void,
}

const verdict: JevVerdict = {
  actionable: 0.9, agentResolvable: 0.8, humanOnIt: 0.05, kind: "runtime_error", kindConfidence: 0.85, depth: "standard", urgency: 1.5,
}

/** Matches the mock reviewer's nitpick, so Jev drops it and the real finding goes back to the agent. */
const NITPICK = /\b(rename|naming|comment|style)\b/i

/** Jev without TypeSafe; only consulted if something new is ingested (`POST /poll` finds nothing) or a mock review reports findings. */
export const fakeJev: JevShape = {
  judge: () => Effect.succeed(verdict),
  judgeInbox: () => Effect.succeed({ ...verdict, kind: "investigation" }),
  judgeFinding: ({ finding, previousRound }) =>
    Effect.succeed(
      NITPICK.test(finding.title)
        ? { realDefect: 0.12, blocking: 0.05, rebutted: previousRound === null ? null : 0.2 }
        : { realDefect: 0.91, blocking: 0.84, rebutted: previousRound === null ? null : 0.1 },
    ),
  /** Every pattern a likely problem an agent could take. */
  judgeLogPatterns: (patterns) => Effect.succeed(patterns.map(() => ({ problem: 0.8, agent: 0.7, users: 0.3 }))),
}

/**
 * Codex without Codex: the first review of a PR finds a real defect and a
 * nitpick, later rounds only the nitpick again. With `fakeJev` dropping the
 * nitpick, round 1 sends the agent back and round 2 passes.
 */
export const fakeReviewer = (delayMs = 6_000): ReviewerShape => ({
  review: ({ prompt }) =>
    Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as({
        summary: prompt.includes("## Round") ? "The overflow is fixed and covered by a test." : "Parses amounts with BigInt, but misses one path.",
        findings: [
          ...(prompt.includes("## Round")
            ? []
            : [
                {
                  file: "packages/api/src/services/reward.ts",
                  line: 88,
                  title: "`formatUnits` still receives a Number for pending rewards",
                  failureScenario: "A Linea campaign with pending rewards above 2^53 wei still goes through `Number(amount)` in `pendingOf`, so /v4/rewards keeps returning 502 for those users.",
                },
              ]),
          {
            file: "packages/api/src/services/reward.ts",
            line: 41,
            title: "Rename `amt` to `amount` for naming consistency",
            failureScenario: "Readers may not understand the abbreviation.",
          },
        ],
      }),
    ),
})

/** How a pull request looks to the fake. `script` PRs move on their own: checks go green, then a reviewer approves. */
export interface FakePr {
  readonly title: string
  readonly checks: "pending" | "green" | "red"
  readonly review: "REVIEW_REQUIRED" | "APPROVED"
  readonly merged: boolean
  /** Moves pending → green (after 15s) → approved (after 30s). Fixtures that must stay put leave it off. */
  readonly moves: boolean
}

export interface FakeGitHubOptions {
  readonly prs: Readonly<Record<string, FakePr>>
  readonly tags: ReadonlyArray<string>
  /** How long `gh pr merge` / `gh release create` take, so `inFlight` shows. */
  readonly latencyMs: number
  /** Tags whose `gh release create` takes this long instead (the release that is in flight at startup). */
  readonly holds: Readonly<Record<string, number>>
  readonly blocked: boolean
  /** A release was cut: the mock's release tracker takes it from here. */
  readonly onRelease: (tag: string) => void
}

/** A PR's head commit: one per PR, the same from `gh pr view` and the head lookup, so a review's pass shows on its merge card. */
const headOf = (url: string): string => new Bun.CryptoHasher("sha1").update(url).digest("hex")

const checks = (state: FakePr["checks"]): PullRequest["statusCheckRollup"] => [
  { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
  { name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
  { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
  state === "pending"
    ? { name: "build", status: "IN_PROGRESS", conclusion: null }
    : { name: "build", status: "COMPLETED", conclusion: state === "green" ? "SUCCESS" : "FAILURE" },
]

/**
 * GitHub Enterprise in memory: PRs, tags and releases, with `gh`'s latency, and
 * an IP-allow-list switch. The real shipper and gates (`ship/gates.ts`) run
 * against it, so a merge or a release resolves once, shows `inFlight` while it
 * runs, and a second click gets a 409.
 */
export const makeFakeGitHub = (options: FakeGitHubOptions) => {
  const prs = new Map(Object.entries(options.prs).map(([url, pr]) => [url, { ...pr, openedAt: Date.now(), mergedAt: pr.merged ? new Date().toISOString() : null }]))
  const tags = [...options.tags]
  let blocked = options.blocked

  const ghe = <A>(operation: string, effect: Effect.Effect<A, GitHubError>): Effect.Effect<A, GitHubError> =>
    Effect.suspend(() =>
      blocked
        ? Effect.fail(new GheBlocked({ operation, message: "HTTP 403: the `Merkl` organization has an IP allow list enabled" }))
        : effect,
    )

  const prOf = (url: string) => {
    const known = prs.get(url)
    if (known !== undefined) return known
    // A PR an agent just opened in the mock: it moves through CI and review on its own.
    const opened = { title: `Bridgetown fix ${prLabel(url)}`, checks: "pending" as const, review: "REVIEW_REQUIRED" as const, merged: false, moves: true, openedAt: Date.now(), mergedAt: null }
    prs.set(url, opened)
    return opened
  }

  const view = (url: string): PullRequest => {
    const pr = prOf(url)
    const age = Date.now() - pr.openedAt
    const ci = pr.moves && age > 15_000 ? "green" : pr.checks
    const review = pr.moves && age > 30_000 ? "APPROVED" : pr.review
    return {
      number: Number(prNumber(url)),
      title: pr.title,
      state: pr.mergedAt === null ? "OPEN" : "MERGED",
      mergedAt: pr.mergedAt,
      headRefOid: headOf(url),
      url,
      reviewDecision: review,
      latestReviews: review === "APPROVED" ? [{ id: `r_${url}`, state: "APPROVED", body: "", author: { login: "baptiste" } }] : [],
      statusCheckRollup: checks(ci),
    }
  }

  const slow = (ms: number) => Effect.sleep(Duration.millis(ms))

  const github: GitHubShape = {
    viewPr: (url) => ghe("pr view", Effect.sync(() => view(url))),
    mergePr: (url) =>
      ghe(
        "pr merge",
        slow(options.latencyMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const pr = prOf(url)
              prs.set(url, { ...pr, mergedAt: pr.mergedAt ?? new Date().toISOString() })
            }),
          ),
        ),
      ),
    rerunFailedJobs: () => ghe("run rerun", slow(options.latencyMs)),
    nextPatchTag: (_repoPath, prefix) => ghe("ls-remote", Effect.sync(() => nextTagFrom(tags, prefix))),
    tagExists: (_repoPath, tag) => ghe("ls-remote", Effect.sync(() => tags.includes(tag))),
    createRelease: (tag) =>
      ghe(
        "release create",
        slow(options.holds[tag] ?? options.latencyMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (!tags.includes(tag)) tags.push(tag)
              options.onRelease(tag)
            }),
          ),
        ),
      ),
    branchHead: (_repoPath, branch) => Effect.succeed(new Bun.CryptoHasher("sha1").update(branch).digest("hex")),
    prHead: (url) => Effect.succeed(headOf(url)),
    markReady: () => ghe("pr ready", slow(options.latencyMs / 3)),
    reachability: Effect.sync(() => (blocked ? "blocked" : "ok")),
  }

  return {
    github,
    /** Flips the IP allow list; returns whether GHE is blocked now. */
    toggleBlocked: () => (blocked = !blocked),
  }
}
