import { type Duration, Effect, Stream } from "effect"

export interface SseTiming {
  /** At most one snapshot per window; changes inside it are coalesced into the next one. */
  readonly coalesce: Duration.Input
  readonly ping: Duration.Input
}

/** docs/API.md: a snapshot on connect and on every change, a `: ping` comment every 15s. */
export const SSE_TIMING: SseTiming = { coalesce: "150 millis", ping: "15 seconds" }

/**
 * The `/events` body. `subscribe` happens before the first snapshot is read, so
 * a change in between is not lost. Changes are throttled rather than debounced:
 * a session logging faster than the window must not starve the app of
 * snapshots. A snapshot that fails to build is logged and skipped.
 */
export const snapshotEvents = <E, R, R2>(
  snapshot: Effect.Effect<unknown, E, R>,
  subscribe: Effect.Effect<Stream.Stream<void>, never, R2>,
  timing: SseTiming = SSE_TIMING,
) => {
  const triggers = Stream.unwrap(
    subscribe.pipe(
      Effect.map((changes) =>
        Stream.concat(
          Stream.succeed(undefined),
          changes.pipe(Stream.throttle({ cost: () => 1, units: 1, duration: timing.coalesce, strategy: "shape" })),
        ),
      ),
    ),
  )
  const snapshots = triggers.pipe(
    Stream.mapEffect(() =>
      snapshot.pipe(
        Effect.map((body): ReadonlyArray<string> => [`event: snapshot\ndata: ${JSON.stringify(body)}\n\n`]),
        Effect.catchCause((cause) => Effect.logWarning("snapshot failed", cause).pipe(Effect.as([]))),
      ),
    ),
    Stream.flattenIterable,
  )
  const pings = Stream.tick(timing.ping).pipe(Stream.drop(1), Stream.as(": ping\n\n"))
  return Stream.merge(snapshots, pings)
}
