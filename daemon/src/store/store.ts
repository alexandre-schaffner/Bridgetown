import { mkdirSync } from "node:fs"
import { join } from "node:path"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator"
import { Context, Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { AdapterError, decodeOr, errorMessage } from "../domain/errors.ts"
import { now } from "../domain/ids.ts"
import { Action, ACTIVE_STATUSES, Alert, type Disposition, Session, TranscriptEntry } from "../domain/model.ts"
import { makeKeyedLock } from "./keyed-lock.ts"
import { migrations } from "./migrations.ts"

export interface StoreShape {
  readonly getAlert: (id: string) => Effect.Effect<Alert | undefined, AdapterError>
  /**
   * Writes the alert. `contentHash` is the Slack message's, set by ingest so an
   * unchanged message is skipped next poll; every other write omits it and the
   * stored hash is kept.
   */
  readonly putAlert: (alert: Alert, contentHash?: string) => Effect.Effect<void, AdapterError>
  /**
   * Read-modify-write, serialized per alert id: `f` sees the row as it is now,
   * never a snapshot from before a slow call. `undefined` from `f` writes nothing.
   */
  readonly modifyAlert: (
    id: string,
    f: (current: Alert | undefined) => Alert | undefined,
    contentHash?: string,
  ) => Effect.Effect<Alert | undefined, AdapterError>
  /** Appends a line to the alert's history; `disposition` also records what you did to its card. */
  readonly appendAlertEvent: (id: string, text: string, disposition?: Disposition["kind"]) => Effect.Effect<void, AdapterError>
  readonly alertHash: (id: string) => Effect.Effect<string | undefined, AdapterError>
  readonly recentAlerts: (limit: number) => Effect.Effect<ReadonlyArray<Alert>, AdapterError>
  /** Every alert received at or after `since` (ISO), newest first. */
  readonly alertsSince: (since: string) => Effect.Effect<ReadonlyArray<Alert>, AdapterError>
  readonly alertsByFingerprint: (fingerprint: string, since: string) => Effect.Effect<ReadonlyArray<Alert>, AdapterError>
  readonly getSession: (id: string) => Effect.Effect<Session | undefined, AdapterError>
  /** Raw write. Only `SessionRepo` calls it; everything else changes sessions through the repo. */
  readonly putSession: (session: Session) => Effect.Effect<void, AdapterError>
  readonly activeSessions: () => Effect.Effect<ReadonlyArray<Session>, AdapterError>
  readonly recentSessions: (limit: number) => Effect.Effect<ReadonlyArray<Session>, AdapterError>
  /** Every session updated at or after `since` (ISO), so every one started then too. */
  readonly sessionsUpdatedSince: (since: string) => Effect.Effect<ReadonlyArray<Session>, AdapterError>
  readonly putAction: (action: Action) => Effect.Effect<void, AdapterError>
  readonly deleteAction: (id: string) => Effect.Effect<void, AdapterError>
  /** Deletes every action matching `predicate`; returns how many. */
  readonly deleteActionsWhere: (predicate: (action: Action) => boolean) => Effect.Effect<number, AdapterError>
  readonly listActions: () => Effect.Effect<ReadonlyArray<Action>, AdapterError>
  readonly appendTranscript: (sessionId: string, entry: TranscriptEntry) => Effect.Effect<void, AdapterError>
  readonly transcript: (sessionId: string, limit: number) => Effect.Effect<ReadonlyArray<TranscriptEntry>, AdapterError>
  readonly getKv: (key: string) => Effect.Effect<string | undefined, AdapterError>
  readonly setKv: (key: string, value: string) => Effect.Effect<void, AdapterError>
}

export class Store extends Context.Service<Store, StoreShape>()("Store") {}

const sqlError = (operation: string) => (cause: unknown) =>
  new AdapterError({ adapter: "sqlite", operation, message: errorMessage(cause), cause })

const StoreImpl = Layer.effect(Store)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    /** A row that no longer decodes is logged and skipped, so one bad record cannot blank the whole app. */
    const decodeRows =
      <A, I>(operation: string, schema: Schema.Codec<A, I>) =>
      (rows: ReadonlyArray<{ readonly json: string }>) =>
        Effect.forEach(rows, (row) =>
          decodeOr("sqlite", operation, Schema.fromJsonString(schema))(row.json).pipe(
            Effect.tapError((error) => Effect.logWarning(`Skipping undecodable row (${operation}): ${error.message}`)),
            Effect.option,
          ),
        ).pipe(Effect.map((decoded) => decoded.flatMap((value) => (value._tag === "Some" ? [value.value] : []))))

    const first = <A>(rows: ReadonlyArray<A>): A | undefined => rows[0]
    const alertLocks = makeKeyedLock()

    const getAlert = (id: string) =>
      sql<{ readonly json: string }>`SELECT json FROM alerts WHERE id = ${id}`.pipe(
        Effect.mapError(sqlError("get alert")),
        Effect.flatMap(decodeRows("decode alert", Alert)),
        Effect.map(first),
      )

    const putAlert = (alert: Alert, contentHash?: string) =>
      (contentHash === undefined
        ? sql`
            INSERT INTO alerts (id, fingerprint, received_at, content_hash, json)
            VALUES (${alert.id}, ${alert.fingerprint}, ${alert.receivedAt}, '', ${JSON.stringify(alert)})
            ON CONFLICT (id) DO UPDATE SET fingerprint = excluded.fingerprint, json = excluded.json
          `
        : sql`
            INSERT INTO alerts (id, fingerprint, received_at, content_hash, json)
            VALUES (${alert.id}, ${alert.fingerprint}, ${alert.receivedAt}, ${contentHash}, ${JSON.stringify(alert)})
            ON CONFLICT (id) DO UPDATE SET
              fingerprint = excluded.fingerprint,
              content_hash = excluded.content_hash,
              json = excluded.json
          `
      ).pipe(Effect.asVoid, Effect.mapError(sqlError("put alert")))

    const modifyAlert = (id: string, f: (current: Alert | undefined) => Alert | undefined, contentHash?: string) =>
      Effect.gen(function* () {
        const next = f(yield* getAlert(id))
        if (next !== undefined) yield* putAlert(next, contentHash)
        return next
      }).pipe(alertLocks.withLock(id))

    const listActions = () =>
      sql<{ readonly json: string }>`SELECT json FROM actions ORDER BY created_at DESC`.pipe(
        Effect.mapError(sqlError("list actions")),
        Effect.flatMap(decodeRows("decode action", Action)),
      )

    const deleteAction = (id: string) =>
      sql`DELETE FROM actions WHERE id = ${id}`.pipe(Effect.asVoid, Effect.mapError(sqlError("delete action")))

    return {
      getAlert,
      putAlert,
      modifyAlert,
      appendAlertEvent: (id, text, disposition) =>
        modifyAlert(id, (alert) => {
          if (alert === undefined) return undefined
          const at = now()
          return {
            ...alert,
            events: [...alert.events, { at, text }],
            disposition: disposition === undefined ? alert.disposition : { kind: disposition, at },
          }
        }).pipe(Effect.asVoid),
      alertHash: (id) =>
        sql<{ readonly hash: string }>`SELECT content_hash AS hash FROM alerts WHERE id = ${id}`.pipe(
          Effect.mapError(sqlError("alert hash")),
          Effect.map((rows) => first(rows)?.hash),
        ),
      recentAlerts: (limit) =>
        sql<{ readonly json: string }>`SELECT json FROM alerts ORDER BY received_at DESC LIMIT ${limit}`.pipe(
          Effect.mapError(sqlError("recent alerts")),
          Effect.flatMap(decodeRows("decode alert", Alert)),
        ),
      alertsSince: (since) =>
        sql<{ readonly json: string }>`SELECT json FROM alerts WHERE received_at >= ${since} ORDER BY received_at DESC`.pipe(
          Effect.mapError(sqlError("alerts since")),
          Effect.flatMap(decodeRows("decode alert", Alert)),
        ),
      alertsByFingerprint: (fingerprint, since) =>
        sql<{ readonly json: string }>`
          SELECT json FROM alerts WHERE fingerprint = ${fingerprint} AND received_at >= ${since}
          ORDER BY received_at DESC
        `.pipe(Effect.mapError(sqlError("alerts by fingerprint")), Effect.flatMap(decodeRows("decode alert", Alert))),
      getSession: (id) =>
        sql<{ readonly json: string }>`SELECT json FROM sessions WHERE id = ${id}`.pipe(
          Effect.mapError(sqlError("get session")),
          Effect.flatMap(decodeRows("decode session", Session)),
          Effect.map(first),
        ),
      putSession: (session) =>
        sql`
          INSERT INTO sessions (id, status, updated_at, json)
          VALUES (${session.id}, ${session.status}, ${session.updatedAt}, ${JSON.stringify(session)})
          ON CONFLICT (id) DO UPDATE SET
            status = excluded.status, updated_at = excluded.updated_at, json = excluded.json
        `.pipe(Effect.asVoid, Effect.mapError(sqlError("put session"))),
      activeSessions: () =>
        sql<{ readonly json: string }>`
          SELECT json FROM sessions WHERE status IN ${sql.in(ACTIVE_STATUSES)} ORDER BY updated_at DESC
        `.pipe(Effect.mapError(sqlError("active sessions")), Effect.flatMap(decodeRows("decode session", Session))),
      recentSessions: (limit) =>
        sql<{ readonly json: string }>`
          SELECT json FROM sessions WHERE status NOT IN ${sql.in(ACTIVE_STATUSES)} ORDER BY updated_at DESC LIMIT ${limit}
        `.pipe(Effect.mapError(sqlError("recent sessions")), Effect.flatMap(decodeRows("decode session", Session))),
      sessionsUpdatedSince: (since) =>
        sql<{ readonly json: string }>`SELECT json FROM sessions WHERE updated_at >= ${since} ORDER BY updated_at DESC`.pipe(
          Effect.mapError(sqlError("sessions since")),
          Effect.flatMap(decodeRows("decode session", Session)),
        ),
      putAction: (action) =>
        sql`
          INSERT INTO actions (id, created_at, json) VALUES (${action.id}, ${action.createdAt}, ${JSON.stringify(action)})
          ON CONFLICT (id) DO UPDATE SET json = excluded.json
        `.pipe(Effect.asVoid, Effect.mapError(sqlError("put action"))),
      deleteAction,
      deleteActionsWhere: (predicate) =>
        listActions().pipe(
          Effect.map((actions) => actions.filter(predicate)),
          Effect.tap((doomed) => Effect.forEach(doomed, (action) => deleteAction(action.id), { discard: true })),
          Effect.map((doomed) => doomed.length),
        ),
      listActions,
      appendTranscript: (sessionId, entry) =>
        sql`INSERT INTO transcript (session_id, json) VALUES (${sessionId}, ${JSON.stringify(entry)})`.pipe(
          Effect.asVoid,
          Effect.mapError(sqlError("append transcript")),
        ),
      transcript: (sessionId, limit) =>
        sql<{ readonly json: string }>`
          SELECT json FROM (
            SELECT seq, json FROM transcript WHERE session_id = ${sessionId} ORDER BY seq DESC LIMIT ${limit}
          ) ORDER BY seq ASC
        `.pipe(Effect.mapError(sqlError("transcript")), Effect.flatMap(decodeRows("decode transcript", TranscriptEntry))),
      getKv: (key) =>
        sql<{ readonly value: string }>`SELECT value FROM kv WHERE key = ${key}`.pipe(
          Effect.mapError(sqlError("get kv")),
          Effect.map((rows) => first(rows)?.value),
        ),
      setKv: (key, value) =>
        sql`
          INSERT INTO kv (key, value) VALUES (${key}, ${value})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value
        `.pipe(Effect.asVoid, Effect.mapError(sqlError("set kv"))),
    }
  }),
)

export const StoreLive = (directory: string) => {
  mkdirSync(directory, { recursive: true })
  const sqlLayer = SqliteClient.layer({ filename: join(directory, "bridgetown.db") })
  const migrationLayer = SqliteMigrator.layer({ loader: migrations, table: "bridgetown_migrations" })
  return StoreImpl.pipe(Layer.provide(migrationLayer), Layer.provide(sqlLayer))
}
