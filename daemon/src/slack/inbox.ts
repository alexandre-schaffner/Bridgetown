import { GH_HOST } from "../config.ts"
import type { InboxFields, ParsedAlert } from "../domain/alert.ts"
import type { SearchMatch, SlackMessage } from "./client.ts"
import { BOT_PREFIX, clean, firstLine, flattenMessage, isPerson, truncate } from "./text.ts"

export type InboxVia = InboxFields["via"]

export interface InboxQuery {
  readonly via: InboxVia
  readonly query: string
}

/** One search per way the user can be reached: by name, through a group, or by DM. */
export const inboxQueries = (me: string, groups: ReadonlyArray<{ readonly id: string }>): ReadonlyArray<InboxQuery> => [
  { via: "mention", query: `<@${me}>` },
  ...groups.map((group): InboxQuery => ({ via: "group", query: `<!subteam^${group.id}>` })),
  { via: "dm", query: `is:dm -from:<@${me}>` },
]

export const threadTsFromPermalink = (permalink: string | undefined): string | null => {
  if (permalink === undefined) return null
  try {
    return new URL(permalink).searchParams.get("thread_ts")
  } catch {
    return null
  }
}

const PR_LINK = new RegExp(`https://${GH_HOST.replaceAll(".", "\\.")}/[\\w.-]+/[\\w.-]+/pull/\\d+`)

export interface InboxContext {
  readonly me: string
  readonly fromName: string
  /**
   * Alert channels. Their bot posts are the alert pipeline's; what people write
   * there (a teammate pinging you in an alert's thread, or at the top level) is
   * the inbox's.
   */
  readonly alertChannels: ReadonlySet<string>
}

const asMessage = (match: SearchMatch): SlackMessage => ({
  ts: match.ts,
  ...(match.text === undefined ? {} : { text: match.text }),
  ...(match.blocks === undefined ? {} : { blocks: match.blocks }),
  ...(match.attachments === undefined ? {} : { attachments: match.attachments }),
})

export const parseInbox = (match: SearchMatch, via: InboxVia, ctx: InboxContext): ParsedAlert | undefined => {
  if (match.user === ctx.me) return undefined
  if (ctx.alertChannels.has(match.channel.id) && !isPerson(match)) return undefined
  const text = flattenMessage(asMessage(match))
  if (text.trim().startsWith(BOT_PREFIX)) return undefined
  const channelKind = match.channel.is_im === true ? "dm" : match.channel.is_mpim === true ? "group_dm" : "channel"
  const threadTs = threadTsFromPermalink(match.permalink)
  const where = channelKind === "channel" ? `#${match.channel.name ?? match.channel.id}` : channelKind === "dm" ? "DM" : "group DM"
  const head = truncate(clean(firstLine(text.replace(new RegExp(`<@${ctx.me}(\\|[^>]*)?>`, "g"), "").trim())) || "(no text)", 90)
  return {
    id: `${match.channel.id}:${match.ts}`,
    channelId: match.channel.id,
    channelName: channelKind === "channel" ? (match.channel.name ?? match.channel.id) : where,
    ts: match.ts,
    title: `${ctx.fromName} · ${where}: ${head}`,
    summary: truncate(clean(text), 140),
    raw: truncate(text, 4_000),
    source: "inbox",
    fingerprint: `inbox:${match.channel.id}:${threadTs ?? match.ts}`,
    fields: {
      _tag: "inbox",
      from: match.user ?? match.username ?? "unknown",
      fromName: ctx.fromName,
      channelKind,
      via,
      threadTs,
      prUrl: PR_LINK.exec(text)?.[0] ?? null,
    },
    mentionsMe: via === "mention",
  }
}
