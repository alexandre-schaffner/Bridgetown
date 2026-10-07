import { Effect, Option, Schema, SchemaGetter } from "effect"
import type { StoreShape } from "../store/store.ts"
import { LogPatternVerdict } from "./judge.ts"
import { LogPattern } from "./logs.ts"

/**
 * What the log sweep keeps across restarts: the patterns Jev judged (so each is
 * asked about once a day) with its verdicts and findings, and the last sweep,
 * which the app reads through `GET /logs`.
 */

/** `{ [pattern key]: Judged }`. */
export const JUDGED_KEY = "watch_log_judged"
/** The last `SweepRecord`. */
const SWEEP_KEY = "watch_log_sweep"
const JUDGED_MS = 24 * 3_600_000

/** What Jev said about a pattern, and the finding it raised. `verdict` is null for one judged before verdicts were kept. */
export const Judged = Schema.Struct({ at: Schema.String, verdict: Schema.NullOr(LogPatternVerdict), alertId: Schema.NullOr(Schema.String) })
export type Judged = typeof Judged.Type

/** A stored entry: from before verdicts were kept, just the time it was judged. */
const JudgedEntry = Schema.Union([
  Judged,
  Schema.String.pipe(
    Schema.decodeTo(Judged, {
      decode: SchemaGetter.transform((at: string) => ({ at, verdict: null, alertId: null })),
      encode: SchemaGetter.transform((judged: Judged) => judged.at),
    }),
  ),
])

const StoredObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const JudgedJson = Schema.fromJsonString(Schema.Record(Schema.String, Judged))

/** The last sweep: every pattern it saw, and the queries that failed. */
export const SweepRecord = Schema.Struct({ at: Schema.String, patterns: Schema.Array(LogPattern), failures: Schema.Array(Schema.String) })
export type SweepRecord = typeof SweepRecord.Type
const SweepJson = Schema.fromJsonString(SweepRecord)

/** The patterns judged in the last day. An unreadable entry is forgotten: at worst, that one pattern is asked about again. */
export const loadJudged = (store: StoreShape, now: Date) =>
  store.getKv(JUDGED_KEY).pipe(
    Effect.map((raw): Record<string, Judged> => {
      const stored = Option.getOrElse(Schema.decodeUnknownOption(StoredObject)(raw ?? "{}"), () => ({}))
      return Object.fromEntries(
        Object.entries(stored).flatMap(([key, value]) => {
          const judged = Option.getOrUndefined(Schema.decodeUnknownOption(JudgedEntry)(value))
          return judged !== undefined && now.getTime() - Date.parse(judged.at) < JUDGED_MS ? [[key, judged]] : []
        }),
      )
    }),
  )

export const saveJudged = (store: StoreShape, judged: Readonly<Record<string, Judged>>) => store.setKv(JUDGED_KEY, Schema.encodeSync(JudgedJson)(judged))

/** The last sweep, or undefined before the first (or when it no longer reads). */
export const loadSweep = (store: StoreShape) =>
  store.getKv(SWEEP_KEY).pipe(Effect.map((raw) => (raw === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(SweepJson)(raw)))))

export const saveSweep = (store: StoreShape, record: SweepRecord) => store.setKv(SWEEP_KEY, Schema.encodeSync(SweepJson)(record))
