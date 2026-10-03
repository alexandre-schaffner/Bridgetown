import type { ThreadReply } from "../domain/alert.ts"
import type { SlackMessage } from "./client.ts"

/** Marks everything Bridgetown posts as the user, so it is never mistaken for them (or re-ingested). */
export const BOT_PREFIX = "🤖"

const TEXT_KEYS = new Set(["text", "title", "pretext", "value"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const collect = (value: unknown, out: Array<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      if (TEXT_KEYS.has(key) && child.trim() !== "") out.push(child)
    } else {
      collect(child, out)
    }
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined)

/**
 * Attachments in reading order: pretext, title, body, fields. Link unfurls
 * (`from_url`) are previews of URLs in the message, not part of the alert.
 */
const attachmentParts = (attachments: unknown): Array<string> => {
  if (!Array.isArray(attachments)) return []
  const parts: Array<string> = []
  for (const attachment of attachments) {
    if (!isRecord(attachment) || "from_url" in attachment) continue
    const body = str(attachment.text) ?? str(attachment.fallback)
    for (const part of [str(attachment.pretext), str(attachment.title), body]) if (part !== undefined) parts.push(part)
    if (Array.isArray(attachment.fields)) {
      for (const field of attachment.fields) {
        if (!isRecord(field)) continue
        const line = [str(field.title), str(field.value)].filter((p) => p !== undefined).join(": ")
        if (line !== "") parts.push(line)
      }
    }
  }
  return parts
}

/**
 * The message as one mrkdwn string. Block Kit and attachments carry the real
 * content; `text` is only the notification fallback ("Deployment merkl-admin v0.6.0"),
 * so it comes first and the structured parts follow.
 */
export const flattenMessage = (message: SlackMessage): string => {
  const parts: Array<string> = []
  if (message.text !== undefined && message.text.trim() !== "") parts.push(message.text)
  const structured: Array<string> = []
  collect(message.blocks, structured)
  structured.push(...attachmentParts(message.attachments))
  for (const part of structured) {
    if (!parts.includes(part)) parts.push(part)
  }
  return parts.join("\n")
}

/** mrkdwn → readable text: links become their label, entities decode. */
export const plain = (mrkdwn: string): string =>
  mrkdwn
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, "$1")
    .replace(/<!subteam\^[A-Z0-9]+>/g, "@team")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")

/** First line with content, skipping bare group pings like `<!subteam^S0AV…>` that Grafana alerts lead with. */
export const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !/^(<!(subteam\^[A-Z0-9]+|here|channel)(\|[^>]*)?>\s*)+$/.test(line)) ?? ""

/** Display text for titles: readable links, no mrkdwn emphasis. */
export const clean = (mrkdwn: string): string =>
  plain(mrkdwn)
    .replace(/[*`]/g, "")
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,:;])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim()

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

export const stripEmoji = (text: string): string => text.replace(/:[a-z0-9_+-]+:/g, "").replace(/\s+/g, " ").trim()

/**
 * A thread as Jev reads it, with one author rule everywhere: Bridgetown's own
 * 🤖 posts and bot messages are `bot` (the former go out under your name but are
 * not you), then your messages are `me`, everyone else is `teammate`.
 */
export const toThreadReplies = (messages: ReadonlyArray<SlackMessage>, me: string | undefined): ReadonlyArray<ThreadReply> =>
  messages.map((message) => {
    const text = plain(flattenMessage(message))
    const bot = message.bot_id !== undefined || text.trimStart().startsWith(BOT_PREFIX)
    return { author: bot ? "bot" : me !== undefined && message.user === me ? "me" : "teammate", text }
  })
