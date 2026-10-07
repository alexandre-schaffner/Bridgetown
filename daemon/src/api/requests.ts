import { Effect, Schema } from "effect"
import { Feedback } from "../domain/alert.ts"
import { attempt, InvalidInput } from "../domain/errors.ts"

/** Request bodies and path ids: anything malformed or out of range is `InvalidInput` (400). `SettingsPatch` is the settings'. */

export const ResolveBody = Schema.Struct({ response: Schema.optional(Schema.NullOr(Schema.String)) })
export const FeedbackBody = Schema.Struct({ label: Feedback })
export const MessageBody = Schema.Struct({ text: Schema.String })
export const PauseBody = Schema.Struct({ paused: Schema.Boolean })

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
