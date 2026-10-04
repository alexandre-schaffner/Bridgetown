import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { AdapterError, attempt, decodeOr } from "../domain/errors.ts"
import { ReviewFinding } from "../domain/model.ts"
import { run, runOk } from "../proc.ts"
import type { ReviewerProfile } from "../triage/policy.ts"

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

/** The user's own `codex` (with its login), or `BRIDGETOWN_CODEX_PATH`. */
const codexExecutable = (): string | undefined => process.env.BRIDGETOWN_CODEX_PATH ?? Bun.which("codex") ?? undefined

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

const codexReview = (request: ReviewRequest): Effect.Effect<Verdict, AdapterError> =>
  Effect.gen(function* () {
    const codex = codexExecutable()
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
      attempt("codex", "tmpdir", () => mkdtemp(join(tmpdir(), "bt-review-"))),
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

export const ReviewerLive = Layer.succeed(Reviewer)({
  review: (request) => {
    switch (request.profile.vendor) {
      case "codex":
        return codexReview(request)
    }
  },
})
