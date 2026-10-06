import { Effect, Schema } from "effect"

export const Channel = Schema.Struct({ id: Schema.String, name: Schema.String, enabled: Schema.Boolean })
export type Channel = typeof Channel.Type

/** Where a reviewer finding starts to block: the defaults, and what settings saved before these existed decode to. */
export const FINDING_THRESHOLDS = { findingReal: 0.6, findingBlocking: 0.5, findingRebutted: 0.6 } as const

export const Thresholds = Schema.Struct({
  autoActionable: Schema.Number,
  autoResolvable: Schema.Number,
  autoHumanOnItMax: Schema.Number,
  suggestActionable: Schema.Number,
  suggestResolvable: Schema.Number,
  /** A reviewer finding blocks the PR only above these (and below `findingRebutted`). Added later, so defaulted. */
  findingReal: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(FINDING_THRESHOLDS.findingReal))),
  findingBlocking: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(FINDING_THRESHOLDS.findingBlocking))),
  findingRebutted: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(FINDING_THRESHOLDS.findingRebutted))),
})
export type Thresholds = typeof Thresholds.Type

export const Settings = Schema.Struct({
  channels: Schema.Array(Channel),
  thresholds: Thresholds,
  autoStart: Schema.Boolean,
  /** Watch mentions, group mentions and DMs across all of Slack, not just alert channels. */
  inbox: Schema.Boolean,
  maxConcurrent: Schema.Number,
  dryRun: Schema.Boolean,
  /** A different model reviews each pushed fix before the PR leaves draft. */
  adversarialReview: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  /** Watch prod signals in Grafana and suggest an investigation when one rises before any alert fires. */
  watchProd: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  pollSeconds: Schema.Number,
  monorepoPath: Schema.String,
  deploymentRepoPath: Schema.String,
  quietHours: Schema.Struct({ enabled: Schema.Boolean, start: Schema.String, end: Schema.String }),
})
export type Settings = typeof Settings.Type
