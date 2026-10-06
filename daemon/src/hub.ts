import { Context, Effect, Layer, PubSub, Ref, type Scope, Semaphore, Stream } from "effect"
import { Environment } from "./config.ts"
import type { AdapterError } from "./domain/errors.ts"
import { loadSettings, type Settings } from "./domain/settings.ts"
import type { Reachability } from "./ship/github.ts"
import { Store } from "./store/store.ts"

export interface Status {
  readonly paused: boolean
  readonly slack: "ok" | "error" | "missing_token"
  readonly jev: "ok" | "error" | "missing_key"
  readonly grafanaMcp: "up" | "down"
  /** GitHub Enterprise reachability. `blocked` is the Merkl org's IP allow list refusing this network. */
  readonly github: Reachability
  readonly lastPollAt: string | null
  /** The latest problem still standing (`HubShape.problem`). */
  readonly error: string | null
}

/** What can go wrong, each reported by the part that saw it, and cleared by that part once it works again. */
export type ProblemSource = "slack" | "poll" | "inbox" | "groups" | "post" | "jev" | "mcp" | "ci" | "setup"

/** One line for a round's problems: the first, and how many more. `null` for a round with none. */
export const problemOf = (lines: ReadonlyArray<string>): string | null => {
  const [first] = lines
  if (first === undefined) return null
  return lines.length === 1 ? first : `${first} (+${lines.length - 1} more)`
}

/**
 * Every field but `error`, which only `problem` sets. Refused by type even on a value whose type carries an `error`
 * (the mock's control line), where an object literal's excess-property check does not apply.
 */
export type StatusPatch = Partial<Omit<Status, "error">> & { readonly error?: never }

export interface HubShape {
  readonly status: Effect.Effect<Status>
  /** Every field but `error` (`StatusPatch`). Atomic: concurrent patches never drop each other. */
  readonly patchStatus: (patch: StatusPatch) => Effect.Effect<void>
  /** `source`'s problem now, or `null` once it works again. */
  readonly problem: (source: ProblemSource, message: string | null) => Effect.Effect<void>
  readonly settings: Effect.Effect<Settings>
  /** Read, change and store in one step: concurrent changes (two toggles flipped quickly) never drop each other. */
  readonly modifySettings: <E>(f: (current: Settings) => Effect.Effect<Settings, E>) => Effect.Effect<Settings, E | AdapterError>
  /** Replaces them whole (tests, the mock daemon), in turn with `modifySettings`. */
  readonly updateSettings: (next: Settings) => Effect.Effect<Settings, AdapterError>
  /** Effective dry-run: the settings toggle or the `--dry-run` flag. */
  readonly dryRun: Effect.Effect<boolean>
  /** Something the snapshot shows changed. */
  readonly notify: Effect.Effect<void>
  /**
   * Subscribes now (for the scope's lifetime): the stream has an element for
   * every `notify` from here on, bursts coalesced. The SSE stream re-sends the
   * snapshot on each, and subscribing before the first snapshot misses nothing.
   */
  readonly subscribe: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
}

export class Hub extends Context.Service<Hub, HubShape>()("Hub") {}

const SETTINGS_KEY = "settings"

interface State {
  readonly status: Omit<Status, "error">
  /** By source, in the order they arose: a changed message counts as new and moves to the end. */
  readonly problems: ReadonlyMap<ProblemSource, string>
}

const withProblem = (problems: ReadonlyMap<ProblemSource, string>, source: ProblemSource, message: string | null): ReadonlyMap<ProblemSource, string> => {
  if ((problems.get(source) ?? null) === message) return problems
  const next = new Map(problems)
  next.delete(source)
  if (message !== null) next.set(source, message)
  return next
}

export const HubLive = Layer.effect(Hub)(
  Effect.gen(function* () {
    const env = yield* Environment
    const store = yield* Store
    const stored = yield* store.getKv(SETTINGS_KEY)
    const settings = yield* Ref.make(loadSettings(stored))
    const state = yield* Ref.make<State>({
      status: {
        paused: (yield* store.getKv("paused")) === "true",
        slack: env.slackToken === undefined || env.slackToken === "" ? "missing_token" : "ok",
        jev: env.typesafeKey === undefined || env.typesafeKey === "" ? "missing_key" : "ok",
        grafanaMcp: "down",
        github: "unknown",
        lastPollAt: null,
      },
      problems: new Map(),
    })
    const persisting = yield* Semaphore.make(1)
    const configuring = yield* Semaphore.make(1)
    // Sliding: a subscriber that has not caught up only needs to know that something changed, not how often.
    const changed = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown)
    const notify = PubSub.publish(changed, undefined).pipe(Effect.asVoid)

    const modifySettings = <E>(f: (current: Settings) => Effect.Effect<Settings, E>) =>
      Effect.gen(function* () {
        const next = yield* f(yield* Ref.get(settings))
        yield* store.setKv(SETTINGS_KEY, JSON.stringify(next))
        yield* Ref.set(settings, next)
        yield* notify
        return next
      }).pipe(configuring.withPermits(1))

    /** Applies `f` in one step; true when anything the snapshot shows changed. */
    const update = (f: (current: State) => State) =>
      Ref.modify(state, (before): readonly [boolean, State] => {
        const after = f(before)
        return [after.problems !== before.problems || JSON.stringify(after.status) !== JSON.stringify(before.status), after]
      })

    return {
      status: Ref.get(state).pipe(Effect.map(({ status, problems }) => ({ ...status, error: [...problems.values()].at(-1) ?? null }))),
      patchStatus: (patch) =>
        Effect.gen(function* () {
          if (!(yield* update((current) => ({ ...current, status: { ...current.status, ...patch } })))) return
          // Written from the state as it is by then, one write at a time, so the stored flag always ends where memory did.
          if (patch.paused !== undefined) {
            yield* Ref.get(state).pipe(
              Effect.flatMap((current) => store.setKv("paused", String(current.status.paused))),
              persisting.withPermits(1),
              Effect.ignore,
            )
          }
          yield* notify
        }),
      problem: (source, message) =>
        update((current) => ({ ...current, problems: withProblem(current.problems, source, message) })).pipe(
          Effect.flatMap((changed) => (changed ? notify : Effect.void)),
        ),
      settings: Ref.get(settings),
      modifySettings,
      updateSettings: (next) => modifySettings(() => Effect.succeed(next)),
      dryRun: Ref.get(settings).pipe(Effect.map((s) => s.dryRun || env.forceDryRun)),
      notify,
      subscribe: PubSub.subscribe(changed).pipe(Effect.map(Stream.fromSubscription)),
    }
  }),
)
