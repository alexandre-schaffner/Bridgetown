import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import type { Depth } from "../domain/alert.ts"
import { ReviewFinding, type ReviewerVendor } from "../domain/critique.ts"
import { AdapterError, attempt, decodeOr } from "../domain/errors.ts"
import type { Effort } from "../domain/session.ts"
import { run, runOk } from "../lib/proc.ts"

export interface ReviewerProfile {
  readonly vendor: ReviewerVendor
  readonly model: string
  /** Codex's reasoning efforts stop at xhigh. */
  readonly effort: Exclude<Effort, "max">
}

/**
 * The adversarial reviewer per triage depth, like `PROFILES` for the coder. Never the coder's vendor (every
 * coder profile is Claude): a different model has different blind spots.
 */
export const REVIEWERS: Readonly<Record<Depth, ReviewerProfile>> = {
  quick: { vendor: "codex", model: "gpt-5.6-sol", effort: "medium" },
  standard: { vendor: "codex", model: "gpt-5.6-sol", effort: "high" },
  deep: { vendor: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
}

export const Verdict = Schema.Struct({
  summary: Schema.String,
  findings: Schema.Array(ReviewFinding),
})
export type Verdict = typeof Verdict.Type

/** `Verdict` for `codex exec --output-schema`, by hand (strict, as structured output requires); a test keeps it in step with `ReviewFinding`. No severity, so there is no tier for nitpicks. */
export const VERDICT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string", description: "One or two sentences: what the change does and whether it holds up." },
    findings: {
      type: "array",
      description: "Blocking defects only. Empty when the change is sound.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "title", "failureScenario"],
        properties: {
          file: { type: "string", description: "Repository-relative path." },
          line: { type: ["integer", "null"] },
          title: { type: "string", description: "The defect in one line." },
          failureScenario: { type: "string", description: "Concrete inputs or state, and the wrong result they produce." },
        },
      },
    },
  },
} as const

export interface ReviewRequest {
  readonly worktree: string
  /** The PR head the verdict is recorded against: the worktree must be at it. */
  readonly head: string
  readonly profile: ReviewerProfile
  readonly prompt: string
}

/** The adversarial reviewer: a model from another vendor than the coder, reading the session's worktree without writing to it. */
export interface ReviewerShape {
  readonly review: (request: ReviewRequest) => Effect.Effect<Verdict, AdapterError>
}

export class Reviewer extends Context.Service<Reviewer, ReviewerShape>()("Reviewer") {}

/** A cold, deep review of a large diff takes a while; past this it is stuck. */
const REVIEW_TIMEOUT_MS = 20 * 60_000

/** A review's scratch directory under `$TMPDIR`, for Codex's output schema and verdict; removed when the review ends. */
const SANDBOX_PREFIX = "bt-review-"

/** Older than any review runs, so no daemon is still using it. */
const STALE_SANDBOX_MS = 24 * 60 * 60_000

/**
 * Removes the review scratch directories in `dir` (`$TMPDIR`) that a daemon killed mid-review (SIGKILL, a crash)
 * never got to remove. Only stale ones, so a review another daemon is running keeps its own.
 */
export const sweepReviewSandboxes = (dir: string, nowMs: number): Effect.Effect<void, AdapterError> =>
  attempt("fs", "sweep review sandboxes", async () => {
    for (const name of await readdir(dir)) {
      if (!name.startsWith(SANDBOX_PREFIX)) continue
      const path = join(dir, name)
      const modified = await stat(path).then((s) => s.mtimeMs, () => nowMs)
      if (nowMs - modified > STALE_SANDBOX_MS) await rm(path, { recursive: true, force: true })
    }
  })

/**
 * Read-only sandbox, nothing persisted, and the user's config (notify hooks,
 * plugins) left out: only the model, effort and output shape Bridgetown picks.
 */
export const codexArgs = (codex: string, request: ReviewRequest, schemaPath: string, outputPath: string): ReadonlyArray<string> => [
  codex,
  "exec",
  "--ephemeral",
  "--ignore-user-config",
  "--sandbox",
  "read-only",
  "--cd",
  request.worktree,
  "--model",
  request.profile.model,
  "--config",
  `model_reasoning_effort="${request.profile.effort}"`,
  "--output-schema",
  schemaPath,
  "--output-last-message",
  outputPath,
  "--color",
  "never",
  request.prompt,
]

/** Why `codex exec` failed, in one line: a missing login says what to run, anything else keeps its last error. */
export const execFailure = (result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string }): string => {
  const output = `${result.stderr}\n${result.stdout}`
  if (/401 Unauthorized|Not logged in/.test(output)) return "codex is not logged in: run `codex login`"
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("ERROR: Reconnecting"))
  return `exited ${result.exitCode}: ${(lines.at(-1) ?? "no output").slice(0, 300)}`
}

/** The user's own `codex` (with its login), or `codexPath` (`BRIDGETOWN_CODEX_PATH`). */
const codexReview = (request: ReviewRequest, codexPath: string | undefined): Effect.Effect<Verdict, AdapterError> =>
  Effect.gen(function* () {
    const codex = codexPath ?? Bun.which("codex") ?? undefined
    if (codex === undefined) {
      return yield* new AdapterError({ adapter: "codex", operation: "exec", message: "codex is not installed (or set BRIDGETOWN_CODEX_PATH)", cause: null })
    }
    // Codex (and Jev's diff) read the worktree: a commit the agent never pushed would pass a head GitHub does not have.
    const local = (yield* runOk(["git", "rev-parse", "HEAD"], { cwd: request.worktree, timeoutMs: 30_000 })).trim()
    if (local !== request.head) {
      const message = `the worktree is at ${local.slice(0, 7)} but the PR head is ${request.head.slice(0, 7)}: the agent's last commit is not pushed`
      return yield* new AdapterError({ adapter: "codex", operation: "exec", message, cause: null })
    }
    const dir = yield* Effect.acquireRelease(
      attempt("codex", "tmpdir", () => mkdtemp(join(tmpdir(), SANDBOX_PREFIX))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    )
    const schemaPath = join(dir, "schema.json")
    const outputPath = join(dir, "verdict.json")
    yield* attempt("codex", "write schema", () => writeFile(schemaPath, JSON.stringify(VERDICT_JSON_SCHEMA)))
    const result = yield* run(codexArgs(codex, request, schemaPath, outputPath), { cwd: request.worktree, timeoutMs: REVIEW_TIMEOUT_MS })
    if (result.exitCode !== 0) return yield* new AdapterError({ adapter: "codex", operation: "exec", message: execFailure(result), cause: result })
    const output = yield* attempt("codex", "read verdict", () => readFile(outputPath, "utf8"))
    return yield* decodeOr("codex", "verdict", Schema.fromJsonString(Verdict))(output)
  }).pipe(Effect.scoped)

export const ReviewerLive = (codexPath: string | undefined) =>
  Layer.succeed(Reviewer)({
    review: (request) => {
      switch (request.profile.vendor) {
        case "codex":
          return codexReview(request, codexPath)
      }
    },
  })
