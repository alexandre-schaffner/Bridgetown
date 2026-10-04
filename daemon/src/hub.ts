import { Context, Effect, Layer, PubSub, Ref, Schema, type Scope, Stream } from "effect"
import { DEFAULT_CHANNELS, DEFAULT_SETTINGS, type Env } from "./config.ts"
import { type AdapterError, errorMessage } from "./domain/errors.ts"
import { Settings } from "./domain/model.ts"
import { Store } from "./store/store.ts"

export interface Status {
  readonly paused: boolean
  readonly slack: "ok" | "error" | "missing_token"
  readonly jev: "ok" | "error" | "missing_key"
  readonly grafanaMcp: "up" | "down"
  /** GitHub Enterprise reachability. `blocked` is the Merkl org's IP allow list refusing this network. */
  readonly github: "ok" | "blocked" | "unknown"
  readonly lastPollAt: string | null
  readonly error: string | null
}

export interface HubShape {
  readonly status: Effect.Effect<Status>
  readonly patchStatus: (patch: Partial<Status>) => Effect.Effect<void>
  readonly settings: Effect.Effect<Settings>
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

/**
 * Stored settings decode against the current schema; new fields fall back to
 * defaults, and default channels added since are appended to the stored ones.
 */
export const loadSettings = (raw: string | undefined): Settings => {
  if (raw === undefined) return DEFAULT_SETTINGS
  try {
    const parsed: unknown = JSON.parse(raw)
    const merged = typeof parsed === "object" && parsed !== null ? { ...DEFAULT_SETTINGS, ...parsed } : DEFAULT_SETTINGS
    const settings = Schema.decodeUnknownSync(Settings)(merged)
    // A channel added to the defaults later is listed, but off: you never chose to watch it.
    const known = new Set(settings.channels.map((c) => c.id))
    const added = DEFAULT_CHANNELS.filter((c) => !known.has(c.id)).map((c) => ({ ...c, enabled: false }))
    return { ...settings, channels: [...settings.channels, ...added] }
  } catch (cause) {
    console.error(`Ignoring stored settings: ${errorMessage(cause)}`)
    return DEFAULT_SETTINGS
  }
}

export const HubLive = (env: Env) =>
  Layer.effect(Hub)(
    Effect.gen(function* () {
      const store = yield* Store
      const stored = yield* store.getKv(SETTINGS_KEY)
      const settings = yield* Ref.make(loadSettings(stored))
      const status = yield* Ref.make<Status>({
        paused: (yield* store.getKv("paused")) === "true",
        slack: env.slackToken === undefined || env.slackToken === "" ? "missing_token" : "ok",
        jev: env.typesafeKey === undefined || env.typesafeKey === "" ? "missing_key" : "ok",
        grafanaMcp: "down",
        github: "unknown",
        lastPollAt: null,
        error: null,
      })
      // Sliding: a subscriber that has not caught up only needs to know that something changed, not how often.
      const changed = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown)
      const notify = PubSub.publish(changed, undefined).pipe(Effect.asVoid)
      return {
        status: Ref.get(status),
        patchStatus: (patch) =>
          Effect.gen(function* () {
            const before = yield* Ref.get(status)
            const after = { ...before, ...patch }
            if (JSON.stringify(before) === JSON.stringify(after)) return
            yield* Ref.set(status, after)
            if (patch.paused !== undefined) yield* store.setKv("paused", String(patch.paused)).pipe(Effect.ignore)
            yield* notify
          }),
        settings: Ref.get(settings),
        updateSettings: (next) =>
          Effect.gen(function* () {
            yield* store.setKv(SETTINGS_KEY, JSON.stringify(next))
            yield* Ref.set(settings, next)
            yield* notify
            return next
          }),
        dryRun: Ref.get(settings).pipe(Effect.map((s) => s.dryRun || env.forceDryRun)),
        notify,
        subscribe: PubSub.subscribe(changed).pipe(Effect.map(Stream.fromSubscription)),
      }
    }),
  )
