import type { ThreadReply } from "../domain/alert.ts"
import type { SlackMessage } from "./client.ts"

/** Slack messages as text: flattened to one mrkdwn string, read as plain text or as Markdown, written from an agent's Markdown, and who wrote them. */

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

/**
 * Slack mrkdwn as Markdown, for the app's renderer (`AlertDetail.raw`): `*bold*` → `**bold**`, `_italic_` → `*italic*`,
 * `~strike~` → `~~strike~~`, fences on lines of their own, `<url|label>` → `[label](<url>)`, `<#C…|name>` → #name,
 * `<@U…>` → @their name from `names` (the id when unknown), `<!here>` → @here, a leading `&gt;` → a quote, and common
 * `:shortcodes:` → emoji. Entities are left for the Markdown parser to decode, but inside code, which it reads verbatim.
 * Slack has no escapes, so a backslash, and a `<` with no closing `>`, stay as written.
 */
export const fromMrkdwn = (mrkdwn: string, names: ReadonlyMap<string, string> = new Map()): string => {
  const parts = mrkdwn.split("```")
  return parts
    .map((part, index) => {
      const code = index % 2 === 1
      if (code && index < parts.length - 1) return `\n\`\`\`\n${decoded(trimOneNewline(part))}\n\`\`\`\n`
      // An unclosed fence is text, its backticks escaped so they stay literal.
      return (code ? "\\`\\`\\`" : "") + textFromMrkdwn(part, names)
    })
    .join("")
}

/** The users `raw` mentions without a label (`<@U123>`), whose names `fromMrkdwn` needs. */
export const mentionedUsers = (mrkdwn: string): ReadonlyArray<string> => [...new Set([...mrkdwn.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1] ?? ""))]

/** Text between fences: inline code kept (decoded), everything else translated. */
const textFromMrkdwn = (text: string, names: ReadonlyMap<string, string>): string => {
  const parts = text.split("`")
  return parts
    .map((part, index) => {
      if (index % 2 === 1 && index < parts.length - 1) return `\`${decoded(part)}\``
      return (index % 2 === 1 ? "\\`" : "") + proseFromMrkdwn(part, names)
    })
    .join("")
}

/** Tokens stand aside as private-use placeholders while emphasis is rewritten: a URL's underscores are never italics, yet `*see <url|docs>*` still bolds the link. */
const PLACEHOLDER_BASE = 0xf0000

const EMPHASIS: ReadonlyArray<readonly [RegExp, string]> = [
  // Bold first, so the `*italic*` it writes is not bolded again. A marker counts only at a word's edge, as in Slack: `snake_case` and `2*3*4` stay.
  [/(?<![\p{L}\p{N}_*\\])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\p{L}\p{N}_*])/gu, "**$1**"],
  [/(?<![\p{L}\p{N}_\\])_(?=\S)([^_\n]+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, "*$1*"],
  [/(?<![\p{L}\p{N}~\\])~(?=\S)([^~\n]+?)(?<=\S)~(?![\p{L}\p{N}~])/gu, "~~$1~~"],
]

const proseFromMrkdwn = (text: string, names: ReadonlyMap<string, string>): string => {
  const tokens: Array<string> = []
  let masked = ""
  let rest = text
  for (;;) {
    const open = rest.indexOf("<")
    const close = open === -1 ? -1 : rest.indexOf(">", open)
    if (close === -1) break
    masked += escapedProse(rest.slice(0, open)) + String.fromCodePoint(PLACEHOLDER_BASE + tokens.length)
    tokens.push(tokenFromMrkdwn(rest.slice(open + 1, close), names))
    rest = rest.slice(close + 1)
  }
  masked += escapedProse(rest)
  for (const [pattern, template] of EMPHASIS) masked = masked.replace(pattern, template)
  masked = masked.replace(/^&gt; ?/gm, ">").replace(/:([a-z0-9_+-]+):/g, (code, name: string) => (name.startsWith("skin-tone-") ? "" : (EMOJI[name] ?? code)))
  return [...masked].map((char) => tokens[(char.codePointAt(0) ?? 0) - PLACEHOLDER_BASE] ?? char).join("")
}

/** Slack has no escapes, so a backslash is always literal, and so is a bare `<`. */
const escapedProse = (text: string): string => text.replace(/\\/g, "\\\\").replace(/</g, "\\<")

/** `<https://x|label>` → a Markdown link; channels, users and groups → their name, the sigil never twice (`<!subteam^S0|@dev>`). */
const tokenFromMrkdwn = (token: string, names: ReadonlyMap<string, string>): string => {
  const bar = token.indexOf("|")
  const target = bar === -1 ? token : token.slice(0, bar)
  const label = bar === -1 ? undefined : token.slice(bar + 1)
  const sigiled = (sigil: string, name: string) => (name.startsWith(sigil) ? name : sigil + name)
  if (target.startsWith("#")) return sigiled("#", label ?? target.slice(1))
  if (target.startsWith("@")) return sigiled("@", label ?? names.get(target.slice(1)) ?? target.slice(1))
  if (target.startsWith("!")) return sigiled("@", label ?? target.slice(1).split("^")[0] ?? "")
  if (!target.includes(":")) return label ?? target
  if (label === undefined || label === target) return `<${target}>`
  return `[${label.replace(/\[/g, "\\[").replace(/\]/g, "\\]")}](<${target}>)`
}

const decoded = (text: string): string => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")

const trimOneNewline = (text: string): string => text.replace(/^\n/, "").replace(/\n$/, "")

/** Slack's names for the emoji alerts and teammates use; anything else stays as written. */
const EMOJI: Readonly<Record<string, string>> = {
  rotating_light: "🚨", warning: "⚠️", fire: "🔥", boom: "💥", x: "❌", no_entry: "⛔", no_entry_sign: "🚫", bangbang: "‼️",
  exclamation: "❗", heavy_exclamation_mark: "❗", question: "❓", white_check_mark: "✅", heavy_check_mark: "✔️",
  ballot_box_with_check: "☑️", red_circle: "🔴", large_red_circle: "🔴", large_green_circle: "🟢", green_circle: "🟢",
  large_yellow_circle: "🟡", yellow_circle: "🟡", large_orange_circle: "🟠", large_blue_circle: "🔵", white_circle: "⚪",
  black_circle: "⚫", red_square: "🟥", green_square: "🟩", yellow_square: "🟨", information_source: "ℹ️", bell: "🔔",
  no_bell: "🔕", mag: "🔍", eyes: "👀", robot_face: "🤖", rocket: "🚀", ship: "🚢", package: "📦", hourglass: "⌛",
  hourglass_flowing_sand: "⏳", stopwatch: "⏱️", alarm_clock: "⏰", clock1: "🕐", chart_with_upwards_trend: "📈",
  chart_with_downwards_trend: "📉", bar_chart: "📊", memo: "📝", pencil: "📝", link: "🔗", lock: "🔒", unlock: "🔓",
  key: "🔑", wrench: "🔧", hammer_and_wrench: "🛠️", gear: "⚙️", construction: "🚧", bug: "🐛", zap: "⚡", sos: "🆘",
  new: "🆕", recycle: "♻️", arrows_counterclockwise: "🔄", repeat: "🔁", arrow_right: "➡️", arrow_up: "⬆️", arrow_down: "⬇️",
  point_right: "👉", point_up: "☝️", "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎", pray: "🙏", raised_hands: "🙌",
  clap: "👏", wave: "👋", ok_hand: "👌", muscle: "💪", tada: "🎉", sparkles: "✨", star: "⭐", "100": "💯", heart: "❤️",
  thinking_face: "🤔", sweat_smile: "😅", smile: "😄", slightly_smiling_face: "🙂", joy: "😂", sob: "😭", scream: "😱",
  skull: "💀", money_with_wings: "💸", moneybag: "💰", gem: "💎", calendar: "📆", date: "📅", pushpin: "📌",
  round_pushpin: "📍", speech_balloon: "💬", loudspeaker: "📢", mega: "📣", satellite_antenna: "📡", computer: "💻",
  globe_with_meridians: "🌐", heavy_plus_sign: "➕", heavy_minus_sign: "➖", heavy_multiplication_x: "✖️",
  large_blue_diamond: "🔷", small_red_triangle: "🔺", small_red_triangle_down: "🔻", white_large_square: "⬜",
  black_large_square: "⬛",
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
const authorOf = (message: SlackMessage, me: string | undefined): ThreadReply["author"] =>
  !isPerson(message) || (message.text ?? "").trimStart().startsWith(BOT_PREFIX) ? "bot" : me !== undefined && message.user === me ? "me" : "teammate"

/** A thread as Jev and agents read it: each message readable, with who wrote it. */
export const toThreadReplies = (messages: ReadonlyArray<SlackMessage>, me: string | undefined): ReadonlyArray<ThreadReply> =>
  messages.map((message) => ({ author: authorOf(message, me), text: plain(flattenMessage(message)) }))
