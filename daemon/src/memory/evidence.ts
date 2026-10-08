import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import { AdapterError, errorMessage } from "../domain/errors.ts"
import { loadSettings } from "../domain/settings.ts"

export const EvidenceKind = Schema.Literals(["message", "user", "action", "finding", "outcome"])
export type EvidenceKind = typeof EvidenceKind.Type
export const Evidence = Schema.Struct({
  id: Schema.String, kind: EvidenceKind, source: Schema.String, at: Schema.String, text: Schema.String,
})
export type Evidence = typeof Evidence.Type

export interface EvidenceStore {
  readonly captureMemory: (kind: EvidenceKind, source: string, text: string, id?: string) => Effect.Effect<void, AdapterError>
  readonly pendingMemory: () => Effect.Effect<ReadonlyArray<Evidence>, AdapterError>
  readonly memoryEvidence: (id: string) => Effect.Effect<Evidence | undefined, AdapterError>
  readonly acknowledgeMemory: (ids: ReadonlyArray<string>, at: string) => Effect.Effect<void, AdapterError>
  readonly pendingMemoryCount: Effect.Effect<number, AdapterError>
  readonly pruneMemory: Effect.Effect<void, AdapterError>
}

/** Scrub launch credentials and common credential formats before evidence crosses the storage/model boundary. */
export const redact = (text: string, secrets: ReadonlyArray<string | undefined> = []): string => {
  let clean = text
  // Capture often wraps message text in JSON, so decode before scrubbing nested strings and keys.
  if (/^\s*[\[{]/.test(text)) {
    const scrubJson = (value: unknown): unknown => {
      if (typeof value === "string") return redact(value, secrets)
      if (Array.isArray(value)) return value.map(scrubJson)
      if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, value]) =>
        [key, /^(?:authorization|password|api[_-]?key|access[_-]?token|secret)$/i.test(key) ? "[redacted]" : scrubJson(value)],
      ))
      return value
    }
    try {
      const value: unknown = JSON.parse(text)
      const scrubbed = JSON.stringify(scrubJson(value))
      if (scrubbed !== JSON.stringify(value)) clean = scrubbed
    } catch { /* Prose and partial JSON still pass through the text rules below. */ }
  }
  for (const secret of secrets) if (secret !== undefined && secret.length >= 4) clean = clean.split(secret).join("[redacted]")
  return clean
    .replace(/\b(?:xox[baprs]-[\w-]+|sk-(?:ant-)?[\w-]{10,}|gh[pousr]_[\w]{10,}|github_pat_[\w]{10,})\b/g, "[redacted]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/("(?:authorization|password|api[_-]?key|access[_-]?token|secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/\b(authorization\s*[:=]\s*bearer\s+|(?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
}

export const evidenceRef = (id: string) => `bridgetown:event/${encodeURIComponent(id)}`

/** Built inside Store's SQLite layer, so capture can join the source write's transaction. */
export const evidenceStore = (sql: SqlClient.SqlClient, secrets: ReadonlyArray<string | undefined>): EvidenceStore => {
  const adapt = (operation: string) => (cause: unknown) => new AdapterError({ adapter: "memory", operation, message: errorMessage(cause), cause })
  const rows = (values: ReadonlyArray<{ readonly json: string }>) => values.map((row) => Schema.decodeUnknownSync(Schema.fromJsonString(Evidence))(row.json))
  return {
    captureMemory: (kind, source, text, id = randomUUID()) => Effect.gen(function* () {
      const [settings] = yield* sql<{ readonly value: string }>`SELECT value FROM kv WHERE key = 'settings'`
      if (!loadSettings(settings?.value).memory) return
      const event: Evidence = { id, kind, source: redact(source, secrets), text: redact(text, secrets).slice(0, 12_000), at: new Date().toISOString() }
      yield* sql`INSERT OR IGNORE INTO memory_evidence (id, json, at) VALUES (${id}, ${JSON.stringify(event)}, ${event.at})`
    }).pipe(Effect.mapError(adapt("capture"))),
    pendingMemory: () => sql<{ readonly json: string }>`SELECT json FROM memory_evidence WHERE processed_at IS NULL ORDER BY seq LIMIT 50`
      .pipe(Effect.map(rows), Effect.mapError(adapt("pending evidence"))),
    memoryEvidence: (id) => sql<{ readonly json: string }>`SELECT json FROM memory_evidence WHERE id = ${id}`
      .pipe(Effect.map((values) => rows(values)[0]), Effect.mapError(adapt("read evidence"))),
    acknowledgeMemory: (ids, at) => sql`UPDATE memory_evidence SET processed_at = ${at} WHERE id IN ${sql.in(ids)} AND processed_at IS NULL`
      .pipe(Effect.asVoid, Effect.mapError(adapt("acknowledge"))),
    pendingMemoryCount: sql<{ readonly count: number }>`SELECT count(*) AS count FROM memory_evidence WHERE processed_at IS NULL`
      .pipe(Effect.map((values) => values[0]?.count ?? 0), Effect.mapError(adapt("count"))),
    pruneMemory: Effect.gen(function* () {
      yield* sql`DELETE FROM memory_evidence WHERE processed_at < ${new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()}`
    }).pipe(Effect.mapError(adapt("prune"))),
  }
}
