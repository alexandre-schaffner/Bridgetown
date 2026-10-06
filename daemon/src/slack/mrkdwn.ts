import type { ThreadReply } from "../domain/alert.ts"
import type { SlackMessage } from "./client.ts"

/** Slack messages as text: flattened to one mrkdwn string, read as plain text or written from an agent's Markdown, and who wrote them. */

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

/**
 * An agent's Markdown as Slack mrkdwn, for what Bridgetown posts: `**bold**` → `*bold*`,
 * `~~strike~~` → `~strike~`, `[label](url)` → `<url|label>`, headings → bold lines, `-`/`*`
 * bullets → `•`. Code, fences (minus their language) and Slack's own `<…>` tokens pass
 * through. A single `*x*` is left alone: in a draft a person edits, it means Slack bold.
 */
export const toMrkdwn = (markdown: string): string =>
  markdown
    .split("```")
    .map((part, index, parts) => {
      if (index % 2 === 0 || index === parts.length - 1) return inlineToMrkdwn(part)
      return part.replace(/^[\w+-]+\n/, "\n")
    })
    .join("```")

const inlineToMrkdwn = (text: string): string =>
  text
    .split("`")
    .map((part, index, parts) => (index % 2 === 1 && index < parts.length - 1 ? part : proseToMrkdwn(part)))
    .join("`")

const proseToMrkdwn = (text: string): string => {
  const tokens: Array<string> = []
  const keep = (token: string): string => `\u0000${tokens.push(token) - 1}\u0000`
  return text
    .replace(/\[([^\]\n]+)\]\((?:<([^>\n]+)>|([^)\s]+))\)/g, (_, label: string, angled?: string, bare?: string) =>
      keep(`<${angled ?? bare}|${label}>`),
    )
    .replace(/<[^<>\n\u0000]+>/g, keep)
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ")
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "*$1*")
    .replace(/(?<![\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])/g, "*$1*")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "~$1~")
    .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t#]*$/gm, (_, heading: string) => `*${heading.replace(/\*/g, "")}*`)
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => tokens[Number(index)] ?? "")
}

/** Display text for titles: readable links, no mrkdwn emphasis. */
export const clean = (mrkdwn: string): string =>
  plain(mrkdwn)
    .replace(/[*`]/g, "")
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,:;])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim()

export const stripEmoji = (text: string): string => text.replace(/:[a-z0-9_+-]+:/g, "").replace(/\s+/g, " ").trim()

/** Written by a person: a user behind it, and no app or bot. A history message and a search match alike. */
export const isPerson = (message: { readonly user?: string | null | undefined; readonly bot_id?: string | null | undefined }): boolean =>
  typeof message.user === "string" && message.user !== "" && (message.bot_id === undefined || message.bot_id === null)

/**
 * Who wrote a thread message, with one rule everywhere: anything no person wrote, and Bridgetown's own 🤖 posts
 * (they go out under your name but are not you), is `bot`; then your messages are `me`, everyone else's `teammate`.
 */
export const authorOf = (message: SlackMessage, me: string | undefined): ThreadReply["author"] =>
  !isPerson(message) || (message.text ?? "").trimStart().startsWith(BOT_PREFIX) ? "bot" : me !== undefined && message.user === me ? "me" : "teammate"

/** A thread as Jev and agents read it: each message readable, with who wrote it. */
export const toThreadReplies = (messages: ReadonlyArray<SlackMessage>, me: string | undefined): ReadonlyArray<ThreadReply> =>
  messages.map((message) => ({ author: authorOf(message, me), text: plain(flattenMessage(message)) }))
