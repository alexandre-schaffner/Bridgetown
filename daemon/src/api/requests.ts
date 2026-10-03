import { Effect, Schema } from "effect"
import { attempt, errorMessage, InvalidInput } from "../domain/errors.ts"
import { Settings } from "../domain/model.ts"

/** Request bodies and path ids: anything malformed or out of range is `InvalidInput` (400). */

const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const ClockTime = Schema.String.check(Schema.isPattern(/^([01][0-9]|2[0-3]):[0-5][0-9]$/))

export const ResolveBody = Schema.Struct({ response: Schema.optional(Schema.NullOr(Schema.String)) })
export const FeedbackBody = Schema.Struct({ label: Schema.Literals(["good", "bad"]) })
export const MessageBody = Schema.Struct({ text: Schema.String })
export const PauseBody = Schema.Struct({ paused: Schema.Boolean })
export const SettingsPatch = Schema.Struct({
  channels: Schema.optional(Settings.fields.channels),
  thresholds: Schema.optional(Schema.Struct({
    autoActionable: Schema.optional(Fraction),
    autoResolvable: Schema.optional(Fraction),
    autoHumanOnItMax: Schema.optional(Fraction),
    suggestActionable: Schema.optional(Fraction),
    suggestResolvable: Schema.optional(Fraction),
  })),
  autoStart: Schema.optional(Schema.Boolean),
  inbox: Schema.optional(Schema.Boolean),
  maxConcurrent: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  dryRun: Schema.optional(Schema.Boolean),
  pollSeconds: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  monorepoPath: Schema.optional(Schema.String),
  deploymentRepoPath: Schema.optional(Schema.String),
  quietHours: Schema.optional(Schema.Struct({
    enabled: Schema.optional(Schema.Boolean),
    start: Schema.optional(ClockTime),
    end: Schema.optional(ClockTime),
  })),
})
export type SettingsPatch = typeof SettingsPatch.Type

/** The JSON body decoded against `schema`; an empty body reads as `{}`. */
export const readBody = <A, I>(request: Request, schema: Schema.Codec<A, I>) =>
  Effect.gen(function* () {
    const text = yield* attempt("http", "read body", () => request.text())
    const parsed = yield* Effect.try({
      try: (): unknown => (text === "" ? {} : JSON.parse(text)),
      catch: () => new InvalidInput({ message: "invalid JSON" }),
    })
    return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(Effect.mapError(() => new InvalidInput({ message: "invalid body" })))
  })

/** A path segment, URL-decoded. Bad percent-encoding is a malformed request. */
export const pathId = (segment: string | undefined) =>
  Effect.try({ try: () => decodeURIComponent(segment ?? ""), catch: () => new InvalidInput({ message: "malformed id" }) })

const defined = (value: object) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))

/** `POST /settings`: the patch over the current settings, nested objects merged key by key, re-checked as a whole. */
export const mergeSettings = (current: Settings, patch: SettingsPatch) =>
  Schema.decodeUnknownEffect(Settings)({
    ...current,
    ...defined(patch),
    thresholds: { ...current.thresholds, ...defined(patch.thresholds ?? {}) },
    quietHours: { ...current.quietHours, ...defined(patch.quietHours ?? {}) },
  }).pipe(Effect.mapError((cause) => new InvalidInput({ message: errorMessage(cause) })))
