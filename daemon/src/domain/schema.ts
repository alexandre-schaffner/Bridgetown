import { Effect, Schema } from "effect"

/** For fields added after rows were first persisted: a missing key decodes as `null`. */
export const nullByDefault = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)))
