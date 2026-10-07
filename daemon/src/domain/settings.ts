import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Schema, Struct } from "effect"
import { errorMessage, InvalidInput } from "./errors.ts"

export const Channel = Schema.Struct({ id: Schema.String, name: Schema.String, enabled: Schema.Boolean })
export type Channel = typeof Channel.Type

const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const ClockTime = Schema.String.check(Schema.isPattern(/^([01][0-9]|2[0-3]):[0-5][0-9]$/))

/** Where Jev's scores decide, each a fraction. */
export const Thresholds = Schema.Struct({
  autoActionable: Fraction,
  autoResolvable: Fraction,
  autoHumanOnItMax: Fraction,
  suggestActionable: Fraction,
  suggestResolvable: Fraction,
  /** A reviewer finding blocks the PR only above these (and below `findingRebutted`). */
  findingReal: Fraction,
  findingBlocking: Fraction,
  findingRebutted: Fraction,
})
export type Thresholds = typeof Thresholds.Type

const QuietHours = Schema.Struct({ enabled: Schema.Boolean, start: ClockTime, end: ClockTime })

export const Settings = Schema.Struct({
  channels: Schema.Array(Channel),
  thresholds: Thresholds,
  autoStart: Schema.Boolean,
  /** Watch mentions, group mentions and DMs across all of Slack, not just alert channels. */
  inbox: Schema.Boolean,
  maxConcurrent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  dryRun: Schema.Boolean,
  /** A different model reviews each pushed fix before the PR leaves draft. */
  adversarialReview: Schema.Boolean,
  /** Watch prod signals in Grafana and investigate one that rises before any alert fires (one Jev doubts is only suggested). */
  watchProd: Schema.Boolean,
  pollSeconds: Schema.Number.check(Schema.isGreaterThan(0)),
  monorepoPath: Schema.String,
  deploymentRepoPath: Schema.String,
  quietHours: QuietHours,
})
export type Settings = typeof Settings.Type

const channel = (id: string, name: string, enabled: boolean): Channel => ({ id, name, enabled })

export const DEFAULT_CHANNELS: ReadonlyArray<Channel> = [
  channel("C0AUKD42N3U", "alert-releases", true),
  channel("C0B001L8UQ1", "alert-uptime", true),
  channel("C0AUK4AUER0", "alert-engine", true),
  channel("C0BL3M3CGUR", "alert-infra", true),
  channel("C0B7KBYGA11", "alert-exporter", true),
  channel("C0BUA3C9Y93", "alert-dev", true),
  channel("C0AUB8LL9MZ", "alert-product", true),
  channel("C0AUB8NCSMR", "alert-product-report", true),
  channel("C0AUCLN8LLB", "alert-missing-prices", true),
  channel("C0AUXV18A7K", "alert-invalid-campaign", true),
  channel("C0B1GEVBBR6", "alert-creators", true),
  channel("C0B0Z6ZH3JM", "alert-dumper", true),
  channel("C0BEBUU5RTQ", "alert-managed-campaigns", true),
  channel("C0C51MRUBMJ", "alert-security", true),
  channel("C0BBTKZLF4H", "alert-autoclaim", true),
  channel("C0BDVR6817G", "alert-unclaimed-rewards", true),
  channel("C0B9CT54W4A", "alert-token-whitelist", true),
  channel("C0BKM3NH6TB", "alert_campaign_events", true),
  channel("C0ATB2GRB70", "general-dungeon-keeper", true),
]

export const DEFAULT_SETTINGS: Settings = {
  channels: DEFAULT_CHANNELS,
  thresholds: {
    autoActionable: 0.8,
    autoResolvable: 0.75,
    autoHumanOnItMax: 0.3,
    suggestActionable: 0.5,
    suggestResolvable: 0.4,
    findingReal: 0.6,
    findingBlocking: 0.5,
    findingRebutted: 0.6,
  },
  autoStart: true,
  inbox: true,
  maxConcurrent: 2,
  dryRun: true,
  adversarialReview: true,
  watchProd: true,
  pollSeconds: 30,
  monorepoPath: join(homedir(), "Projects", "merkl", "monorepo"),
  deploymentRepoPath: join(homedir(), "Projects", "merkl", "apps-deployment"),
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * `top` over `base`, object by object: a key `top` leaves out keeps `base`'s value, however deep. Anything else
 * (a list, a number) `top` gives replaces `base`'s whole. Keys `base` lacks are left out.
 */
const over = (base: unknown, top: unknown): unknown =>
  isRecord(base) && isRecord(top)
    ? Object.fromEntries(Object.entries(base).map(([key, value]) => [key, top[key] === undefined ? value : over(value, top[key])]))
    : (top ?? base)

/**
 * The stored settings over the defaults, so a setting added since takes its default. A default channel added since
 * is listed, but off: you never chose to watch it. Unreadable settings give the defaults.
 */
export const loadSettings = (raw: string | undefined): Settings => {
  if (raw === undefined) return DEFAULT_SETTINGS
  try {
    const settings = Schema.decodeUnknownSync(Settings)(over(DEFAULT_SETTINGS, JSON.parse(raw)))
    const known = new Set(settings.channels.map((c) => c.id))
    const added = DEFAULT_CHANNELS.filter((c) => !known.has(c.id)).map((c) => ({ ...c, enabled: false }))
    // A poll stored before the patch took whole seconds of at least 10 reads as the loop runs it: the app decodes whole seconds.
    const pollSeconds = Math.max(MIN_POLL_SECONDS, Math.round(settings.pollSeconds))
    return { ...settings, pollSeconds, channels: [...settings.channels, ...added] }
  } catch (cause) {
    console.error(`Ignoring stored settings: ${errorMessage(cause)}`)
    return DEFAULT_SETTINGS
  }
}

/** The shortest poll the loop runs, in whole seconds. */
export const MIN_POLL_SECONDS = 10

/**
 * `POST /settings`: any setting, and any key of `thresholds` and `quietHours` on its own. A poll is whole seconds and
 * at least `MIN_POLL_SECONDS`, as the poll loop takes it; a poll stored before that rule loads rounded to it.
 */
export const SettingsPatch = Schema.Struct({
  ...Struct.map(Settings.fields, Schema.optional),
  pollSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_POLL_SECONDS))),
  thresholds: Schema.optional(Thresholds.mapFields(Struct.map(Schema.optional))),
  quietHours: Schema.optional(QuietHours.mapFields(Struct.map(Schema.optional))),
})
export type SettingsPatch = typeof SettingsPatch.Type

/** The patch over the current settings, the way stored settings go over the defaults, re-checked as a whole. */
export const mergeSettings = (current: Settings, patch: SettingsPatch) =>
  Schema.decodeUnknownEffect(Settings)(over(current, patch)).pipe(Effect.mapError((cause) => new InvalidInput({ message: errorMessage(cause) })))
