import { Context, Effect, Layer, Schema } from "effect"
import { GH_HOST, GHE_REPO } from "../config.ts"
import { type AdapterError, decodeOr, GheBlocked, type GitHubError } from "../domain/errors.ts"
import { run, runOk } from "../proc.ts"

/** What `gh` / git print when the Merkl org's IP allow list refuses this network. */
export const refusedByAllowList = (stderr: string): boolean => /IP allow list|403/.test(stderr)

/** A GHE call refused by the allow list is `GheBlocked`; anything else stays an `AdapterError`. */
const onGhe = <A, R>(effect: Effect.Effect<A, AdapterError, R>): Effect.Effect<A, GitHubError, R> =>
  effect.pipe(
    Effect.catchTag("AdapterError", (error): Effect.Effect<never, GitHubError> =>
      refusedByAllowList(error.message) ? Effect.fail(new GheBlocked({ operation: error.operation, message: error.message })) : Effect.fail(error),
    ),
  )

const gh = (args: ReadonlyArray<string>, cwd?: string) =>
  onGhe(runOk(["gh", ...args], { env: { GH_HOST }, timeoutMs: 120_000, ...(cwd === undefined ? {} : { cwd }) }))

const Check = Schema.Struct({
  name: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.String),
  detailsUrl: Schema.optional(Schema.String),
  targetUrl: Schema.optional(Schema.String),
})

const Review = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  body: Schema.String,
  author: Schema.Struct({ login: Schema.String }),
})

const PullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
  isDraft: Schema.optional(Schema.Boolean),
  /** The head commit, which a passed review must have read for the merge card to say so. */
  headRefOid: Schema.String,
  url: Schema.String,
  reviewDecision: Schema.NullOr(Schema.String),
  latestReviews: Schema.Array(Review),
  statusCheckRollup: Schema.Array(Check),
})
export type PullRequest = typeof PullRequest.Type

export type CiState =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Green" }
  | { readonly _tag: "Red"; readonly failing: ReadonlyArray<{ readonly name: string; readonly url: string }> }

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"])

export const ciState = (pr: PullRequest): CiState => {
  const checks = pr.statusCheckRollup
  const failing = checks
    .filter((c) => FAILED.has((c.conclusion ?? c.state ?? "").toUpperCase()))
    .map((c) => ({ name: c.name ?? c.context ?? "check", url: c.detailsUrl ?? c.targetUrl ?? "" }))
  if (failing.length > 0) return { _tag: "Red", failing }
  const pending = checks.some((c) => {
    if (c.status !== undefined) return c.status.toUpperCase() !== "COMPLETED"
    return (c.state ?? "").toUpperCase() === "PENDING" || (c.state ?? "").toUpperCase() === "EXPECTED"
  })
  return pending || checks.length === 0 ? { _tag: "Pending" } : { _tag: "Green" }
}

const viewPr = (prUrl: string) =>
  gh(["pr", "view", prUrl, "--json", "number,title,state,mergedAt,isDraft,headRefOid,url,reviewDecision,latestReviews,statusCheckRollup"]).pipe(
    Effect.flatMap((out) => decodeOr("gh", "pr view", Schema.fromJsonString(PullRequest))(out)),
  )

const mergePr = (prUrl: string) => gh(["pr", "merge", prUrl, "--squash"]).pipe(Effect.asVoid)

const rerunFailedJobs = (runId: string) => gh(["run", "rerun", runId, "--failed", "-R", GHE_REPO]).pipe(Effect.asVoid)

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const parseVersion = (tag: string, prefix: string): ReadonlyArray<number> | undefined => {
  const match = new RegExp(`^${escape(prefix)}-v(\\d+)\\.(\\d+)\\.(\\d+)$`).exec(tag)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

const compare = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number =>
  (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0)

/**
 * The tag after the highest `<prefix>-vX.Y.Z` in `tags`: a patch bump, or
 * `<prefix>-v0.1.0` for the first release of a prefix.
 */
export const nextTagFrom = (tags: ReadonlyArray<string>, prefix: string): string => {
  const latest = tags
    .map((tag) => parseVersion(tag, prefix))
    .filter((v): v is ReadonlyArray<number> => v !== undefined)
    .sort(compare)
    .at(-1)
  if (latest === undefined) return `${prefix}-v0.1.0`
  return `${prefix}-v${latest[0] ?? 0}.${latest[1] ?? 0}.${(latest[2] ?? 0) + 1}`
}

const nextPatchTag = (repoPath: string, prefix: string) =>
  onGhe(runOk(["git", "ls-remote", "--tags", "--refs", "origin", `refs/tags/${prefix}-v*`], { cwd: repoPath, timeoutMs: 60_000 })).pipe(
    Effect.map((out) => nextTagFrom(out.split("\n").map((line) => line.split("refs/tags/")[1]?.trim() ?? ""), prefix)),
  )

const tagExists = (repoPath: string, tag: string) =>
  onGhe(runOk(["git", "ls-remote", "--tags", "--refs", "origin", `refs/tags/${tag}`], { cwd: repoPath, timeoutMs: 60_000 })).pipe(
    Effect.map((out) => out.trim() !== ""),
  )

const createRelease = (tag: string, notes: string) =>
  gh(["release", "create", tag, "--target", "main", "--title", tag, "--notes", notes, "-R", GHE_REPO]).pipe(Effect.asVoid)

/** Evidence that the agent pushed its branch: the commit its ref points at on origin. Unknown (no answer) counts as not pushed. */
const branchHead = (repoPath: string, branch: string) =>
  run(["git", "ls-remote", "--heads", "origin", branch], { cwd: repoPath, timeoutMs: 30_000 }).pipe(
    Effect.map((result) => (result.exitCode === 0 ? (result.stdout.trim().split(/\s+/)[0] ?? "") : "")),
    Effect.map((sha) => (sha === "" ? null : sha)),
    Effect.orElseSucceed(() => null),
  )

/** The commit a PR's head points at: what the adversarial review reads, whichever branch the PR is on. */
const prHead = (prUrl: string) =>
  gh(["pr", "view", prUrl, "--json", "headRefOid", "-q", ".headRefOid"]).pipe(Effect.map((out) => (out.trim() === "" ? null : out.trim())))

/** Takes a draft PR out of draft once the adversarial review passed. Idempotent: an already ready PR stays ready. */
const markReady = (prUrl: string) => gh(["pr", "ready", prUrl]).pipe(Effect.asVoid)

export type Reachability = "ok" | "blocked" | "unknown"

const reachability: Effect.Effect<Reachability> = run(["gh", "api", "user", "--hostname", GH_HOST], { timeoutMs: 20_000 }).pipe(
  Effect.map((result): Reachability => (result.exitCode === 0 ? "ok" : refusedByAllowList(result.stderr) ? "blocked" : "unknown")),
  Effect.orElseSucceed((): Reachability => "unknown"),
)

/**
 * Everything the daemon asks of GitHub Enterprise (`gh`, `git ls-remote`), as a
 * service: the mock daemon and tests swap in a fake so merges, releases and CI
 * run through the real ship flow without touching GHE.
 */
export interface GitHubShape {
  readonly viewPr: (prUrl: string) => Effect.Effect<PullRequest, GitHubError>
  readonly mergePr: (prUrl: string) => Effect.Effect<void, GitHubError>
  readonly rerunFailedJobs: (runId: string) => Effect.Effect<void, GitHubError>
  /** Next tag for `prefix` (e.g. `admin` → `admin-v0.6.1`), read from the remote so local clones can lag. */
  readonly nextPatchTag: (repoPath: string, prefix: string) => Effect.Effect<string, GitHubError>
  /** Whether `tag` exists on origin; a release that may or may not have been cut is checked here, never re-cut. */
  readonly tagExists: (repoPath: string, tag: string) => Effect.Effect<boolean, GitHubError>
  readonly createRelease: (tag: string, notes: string) => Effect.Effect<void, GitHubError>
  /** The commit `branch` points at on origin, `null` when it was not pushed. */
  readonly branchHead: (repoPath: string, branch: string) => Effect.Effect<string | null>
  readonly prHead: (prUrl: string) => Effect.Effect<string | null, GitHubError>
  readonly markReady: (prUrl: string) => Effect.Effect<void, GitHubError>
  /** `blocked`: the Merkl org's IP allow list refuses this network. */
  readonly reachability: Effect.Effect<Reachability>
}

export class GitHub extends Context.Service<GitHub, GitHubShape>()("GitHub") {}

export const GitHubLive = Layer.succeed(GitHub)({
  viewPr,
  mergePr,
  rerunFailedJobs,
  nextPatchTag,
  tagExists,
  createRelease,
  branchHead,
  prHead,
  markReady,
  reachability,
})
