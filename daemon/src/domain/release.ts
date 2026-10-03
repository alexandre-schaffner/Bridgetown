import { Schema } from "effect"
import type { Stage } from "./model.ts"

/**
 * Where a release tracker says a deploy is, read once from its stages. The
 * parser's headline, the rules' filter reason and the shipper's next step all
 * come from this, so they can never disagree. Persisted on the session as
 * `deployStage` so a tracker edit that changes nothing (a reaction, a reply)
 * is recognised as such.
 */
export const ReleaseState = Schema.Union([
  /** The tracker has no stages yet. */
  Schema.TaggedStruct("Starting", {}),
  Schema.TaggedStruct("InProgress", { stage: Schema.String }),
  /** The `Approval` stage is waiting on the reviewers: slow by design, never a stall. */
  Schema.TaggedStruct("AwaitingApproval", {}),
  Schema.TaggedStruct("Failed", { stage: Schema.String, detail: Schema.String }),
  Schema.TaggedStruct("Deployed", {}),
])
export type ReleaseState = typeof ReleaseState.Type

export const releaseState = (stages: ReadonlyArray<Stage>): ReleaseState => {
  const failed = stages.find((s) => s.status === "failure")
  if (failed !== undefined) return { _tag: "Failed", stage: failed.name, detail: failed.detail }
  const approval = stages.find((s) => s.name === "Approval")
  if (approval !== undefined && approval.status !== "success") return { _tag: "AwaitingApproval" }
  const moving = stages.find((s) => s.status === "in_progress" || s.status === "pending")
  if (moving !== undefined) return { _tag: "InProgress", stage: moving.name }
  if (stages.length === 0) return { _tag: "Starting" }
  return { _tag: "Deployed" }
}

/** Same state and stage. A failure's detail (attempt counts) changing is not a new failure. */
export const sameReleaseState = (a: ReleaseState | null, b: ReleaseState): boolean => {
  if (a === null || a._tag !== b._tag) return false
  if (a._tag === "InProgress" && b._tag === "InProgress") return a.stage === b.stage
  if (a._tag === "Failed" && b._tag === "Failed") return a.stage === b.stage
  return true
}

/** The tracker's headline: "Build failed", "Waiting for approval", "Production › ETL deploy failed"… */
export const releaseHeadline = (state: ReleaseState): string => {
  switch (state._tag) {
    case "Failed":
      if (state.stage === "Build") return "Build failed"
      if (state.stage === "Approval") return "Approval rejected"
      return `${state.stage} deploy failed`
    case "AwaitingApproval":
      return "Waiting for approval"
    case "InProgress":
      return `${state.stage} in progress`
    case "Starting":
      return "Starting"
    case "Deployed":
      return "Deployed"
  }
}
