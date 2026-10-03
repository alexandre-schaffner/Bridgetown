import { Effect, Schema } from "effect"

/** An outside system (sqlite, a subprocess, the network, the SDK) failed in a way nobody branches on. HTTP 500. */
export class AdapterError extends Schema.TaggedError<AdapterError>()("AdapterError", {
  adapter: Schema.String,
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

/** A credential the daemon was not given: no Slack token (`Status.slack` missing_token) or TypeSafe key (`Status.jev` missing_key). */
export class MissingCredential extends Schema.TaggedError<MissingCredential>()("MissingCredential", {
  service: Schema.Literals(["slack", "jev"]),
  message: Schema.String,
}) {}

/** Slack refused a call: its own error `code` (`ratelimited`, `channel_not_found`, `not_posted`…) or `http_<status>`. */
export class SlackApiError extends Schema.TaggedError<SlackApiError>()("SlackApiError", {
  method: Schema.String,
  code: Schema.String,
  message: Schema.String,
}) {}

/** GitHub Enterprise refuses this network (the Merkl org's IP allow list): nothing on GHE works until it changes. */
export class GheBlocked extends Schema.TaggedError<GheBlocked>()("GheBlocked", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** What a call to GitHub Enterprise (`gh`, `git ls-remote`) can fail with. */
export type GitHubError = AdapterError | GheBlocked

/** An id the API was asked about does not exist. HTTP 404. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { message: Schema.String }) {}

/** The request is valid but the current state does not allow it. HTTP 409. */
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", { message: Schema.String }) {}

/** A malformed or out-of-range request body. HTTP 400. */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", { message: Schema.String }) {}

/** Every typed failure a service can hand the API. */
export type DaemonError = AdapterError | MissingCredential | SlackApiError | GheBlocked | NotFound | Conflict | InvalidInput

/** The one place typed failures become HTTP statuses (docs/API.md "Errors"). */
export const statusOf = (error: DaemonError): number => {
  switch (error._tag) {
    case "InvalidInput":
      return 400
    case "NotFound":
      return 404
    case "Conflict":
      return 409
    case "AdapterError":
    case "MissingCredential":
    case "SlackApiError":
    case "GheBlocked":
      return 500
  }
}

export const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** Every Promise boundary, wrapped the same way. */
export const attempt = <A>(adapter: string, operation: string, run: () => Promise<A>): Effect.Effect<A, AdapterError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AdapterError({ adapter, operation, message: errorMessage(cause), cause }),
  })

export const decodeOr =
  <A, I>(adapter: string, operation: string, schema: Schema.Codec<A, I>) =>
  (value: unknown): Effect.Effect<A, AdapterError> =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((cause) => new AdapterError({ adapter, operation, message: errorMessage(cause), cause })),
    )
