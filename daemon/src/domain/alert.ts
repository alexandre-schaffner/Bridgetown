import type { Alert, AlertEvent, AlertFields, AlertSource, Claimant, Disposition, Feedback, Triage } from "./model.ts"

/** A Slack message read as an alert or an inbox item, before anything is stored or decided. */
export interface ParsedAlert {
  readonly id: string
  readonly channelId: string
  readonly channelName: string
  readonly ts: string
  readonly title: string
  readonly summary: string
  readonly raw: string
  readonly source: AlertSource
  readonly fingerprint: string
  readonly fields: AlertFields
  readonly mentionsMe: boolean
  readonly fromHuman: boolean
}

/** One message of a thread, for Jev, labelled by who wrote it. */
export interface ThreadReply {
  readonly author: "bot" | "me" | "teammate"
  readonly text: string
}

export interface AlertRecord {
  readonly permalink: string | null
  readonly receivedAt: string
  readonly triage: Triage
  readonly sessionId: string | null
  readonly events: ReadonlyArray<AlertEvent>
  readonly feedback?: Feedback | null
  readonly disposition?: Disposition | null
  readonly claimedBy?: ReadonlyArray<Claimant>
}

/** The stored alert for a parsed message. The one place a `ParsedAlert` becomes an `Alert`. */
export const alertFromParsed = (parsed: ParsedAlert, record: AlertRecord): Alert => ({
  id: parsed.id,
  channelId: parsed.channelId,
  channelName: parsed.channelName,
  ts: parsed.ts,
  permalink: record.permalink,
  title: parsed.title,
  summary: parsed.summary,
  raw: parsed.raw,
  source: parsed.source,
  fingerprint: parsed.fingerprint,
  fields: parsed.fields,
  mentionsMe: parsed.mentionsMe,
  receivedAt: record.receivedAt,
  triage: record.triage,
  sessionId: record.sessionId,
  feedback: record.feedback ?? null,
  events: record.events,
  disposition: record.disposition ?? null,
  claimedBy: record.claimedBy ?? [],
})
