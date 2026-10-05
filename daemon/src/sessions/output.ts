import { Schema } from "effect"
import { GH_HOST, GHE_REPO } from "../config.ts"
import { Outcome, Recommendation } from "../domain/model.ts"

export const SessionResult = Schema.Struct({
  outcome: Outcome,
  rootCauseFound: Schema.Boolean,
  diagnosis: Schema.String,
  tried: Schema.Array(Schema.String),
  summary: Schema.String,
  prUrl: Schema.NullOr(Schema.String),
  recommendation: Schema.NullOr(Recommendation),
  recommendationDetail: Schema.NullOr(Schema.String),
  releasePrefix: Schema.NullOr(Schema.String),
})
export type SessionResult = typeof SessionResult.Type

const OWN_PR = new RegExp(`^https://${GH_HOST.replaceAll(".", "\\.")}/${GHE_REPO}/pull/(\\d+)(?:[/?#].*)?$`)

/**
 * The agent's PR link as the PR's own URL, if it is a pull request on the repo Bridgetown ships (a link
 * into one, like its files tab, counts): anything else (another repo's PR, a teammate's link from an
 * untrusted Slack message, a non-https URL) is no PR. The merge card runs `gh pr merge` on it with your
 * credentials.
 */
export const ownPrUrl = (url: string | null | undefined): string | null => {
  const number = url === null || url === undefined ? undefined : OWN_PR.exec(url)?.[1]
  return number === undefined ? null : `https://${GH_HOST}/${GHE_REPO}/pull/${number}`
}

/** What the SDK enforces on the final message; decoded again with `SessionResult` at the boundary. */
export const SESSION_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "rootCauseFound", "diagnosis", "tried", "summary", "prUrl", "recommendation", "recommendationDetail", "releasePrefix"],
  properties: {
    outcome: {
      type: "string",
      enum: ["fix_pr", "recommendation", "no_action", "needs_human"],
      description:
        "fix_pr: you opened a pull request that fixes it. recommendation: no code change; a person should apply your recommendation. no_action: nothing is actually wrong anymore. needs_human: you could not get far enough.",
    },
    rootCauseFound: {
      type: "boolean",
      description:
        "True only when you confirmed the cause with evidence (a log line, a failing command you reproduced, an onchain tx status, a diff). A plausible hypothesis is false.",
    },
    diagnosis: {
      type: "string",
      description: "Root cause in 2–4 plain sentences with the evidence (log line, file:line). If not found: the best hypothesis, labelled as such, and what would confirm it.",
    },
    tried: {
      type: "array",
      items: { type: "string" },
      description: "Each avenue you actually tried and what it showed, one short line each (e.g. 'grafana: no tx-executor logs in the window').",
    },
    summary: { type: "string", description: "One line for Slack, e.g. 'vite 6.4 broke the admin build; PR pins 6.3'." },
    prUrl: { type: ["string", "null"], description: "The pull request URL when outcome is fix_pr." },
    recommendation: {
      type: ["string", "null"],
      enum: ["rerun_failed_jobs", "revert", "no_code_change", null],
      description: "rerun_failed_jobs for flaky infrastructure; revert when a recent change must be undone; no_code_change for an operational fix you describe.",
    },
    recommendationDetail: { type: ["string", "null"], description: "Exactly what the person should do." },
    releasePrefix: {
      type: ["string", "null"],
      description: "Release tag prefix to cut after merge, e.g. 'admin' for admin-vX.Y.Z or 'api'. Null when no release is needed.",
    },
  },
} as const
