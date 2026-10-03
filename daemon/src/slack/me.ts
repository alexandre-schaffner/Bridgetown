import { Cache, Context, Duration, Effect, Exit, Layer, Ref } from "effect"
import { Hub } from "../hub.ts"
import { type SlackError, type SlackIdentity, SlackClient } from "./client.ts"

export interface UserGroup {
  readonly id: string
  readonly handle: string
}

/** Who the Slack token belongs to, their user groups, and display names: looked up once and cached. */
export interface SlackMeShape {
  /** Fetched on first success and kept; a failure updates `Status.slack` and is retried next call. */
  readonly identity: Effect.Effect<SlackIdentity, SlackError>
  /** The identity if it is already known, without asking Slack. */
  readonly known: Effect.Effect<SlackIdentity | undefined>
  /** The user's groups, refreshed hourly; empty without the `usergroups:read` scope. */
  readonly groups: Effect.Effect<ReadonlyArray<UserGroup>>
  /** A user's display name, or their id when Slack cannot say (asked again next time). */
  readonly nameOf: (userId: string) => Effect.Effect<string>
}

export class SlackMe extends Context.Service<SlackMe, SlackMeShape>()("SlackMe") {}

const GROUPS_TTL = Duration.hours(1)
const NAMES_CAPACITY = 2_000

/** Successes are kept for good, failures not at all: the next call asks Slack again. */
const successesOnly = <A, E>(exit: Exit.Exit<A, E>): Duration.Duration => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)

export const SlackMeLive = Layer.effect(SlackMe)(
  Effect.gen(function* () {
    const slack = yield* SlackClient
    const hub = yield* Hub
    const known = yield* Ref.make<SlackIdentity | undefined>(undefined)

    const identity = yield* Effect.cachedWithTTL(
      slack.identity().pipe(
        Effect.tap((found) => Ref.set(known, found)),
        Effect.tapError((error) =>
          hub.patchStatus({ slack: error._tag === "MissingCredential" ? "missing_token" : "error", error: `Slack: ${error.message}` }),
        ),
      ),
      successesOnly,
    )

    const groupsOfMe = yield* Effect.gen(function* () {
      const me = yield* Ref.get(known)
      if (me === undefined) return []
      return yield* slack.groupsOf(me.user_id).pipe(
        Effect.tapError((error) => hub.patchStatus({ error: `Slack user groups: ${error.message} (add the usergroups:read scope)` })),
        Effect.orElseSucceed((): ReadonlyArray<UserGroup> => []),
      )
    }).pipe(Effect.cachedWithTTL(GROUPS_TTL))

    const names = yield* Cache.makeWith((userId: string) => slack.userName(userId), { capacity: NAMES_CAPACITY, timeToLive: successesOnly })

    return {
      identity,
      known: Ref.get(known),
      // Before the identity is known there is nobody to look groups up for, and that empty answer is not cached.
      groups: Effect.gen(function* () {
        return (yield* Ref.get(known)) === undefined ? [] : yield* groupsOfMe
      }),
      nameOf: (userId) => Cache.get(names, userId).pipe(Effect.orElseSucceed(() => userId)),
    }
  }),
)
