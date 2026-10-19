import type { InboxFields, ParsedAlert } from "../domain/alert.ts"
import { firstLine, truncate } from "../lib/text.ts"
import { findPrUrl } from "../ship/pr.ts"
import type { SearchMatch } from "./client.ts"
import { BOT_PREFIX, clean, flattenMessage, isPerson, nameMentions } from "./mrkdwn.ts"

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

export interface InboxContext {
  readonly me: string
  readonly fromName: string
  /** The names of the people the message mentions (`SlackMe.namesIn`); one missing reads "@someone". */
  readonly names: ReadonlyMap<string, string>
  /**
   * Alert channels. Their bot posts are alerts, which `AlertChannels` reads; what
   * people write there (a teammate pinging you in an alert's thread, or at the
   * top level) is the inbox's.
   */
  readonly alertChannels: ReadonlySet<string>
}

export const parseInbox = (match: SearchMatch, via: InboxVia, ctx: InboxContext): ParsedAlert | undefined => {
  if (match.user === ctx.me) return undefined
  if (ctx.alertChannels.has(match.channel.id) && !isPerson(match)) return undefined
  const text = flattenMessage(match)
  if (text.trim().startsWith(BOT_PREFIX)) return undefined
  const channelKind = match.channel.is_im === true ? "dm" : match.channel.is_mpim === true ? "group_dm" : "channel"
  const threadTs = threadTsFromPermalink(match.permalink)
  const where = channelKind === "channel" ? `#${match.channel.name ?? match.channel.id}` : channelKind === "dm" ? "DM" : "group DM"
  // What you read in a notification: people by name, one Slack could not name as "@someone", never an id.
  const named = (mrkdwn: string) => clean(nameMentions(mrkdwn, ctx.names, () => "@someone"))
  const head = truncate(named(firstLine(text.replace(new RegExp(`<@${ctx.me}(\\|[^>]*)?>`, "g"), "").trim())) || "(no text)", 90)
  return {
    id: `${match.channel.id}:${match.ts}`,
    channelId: match.channel.id,
    channelName: channelKind === "channel" ? (match.channel.name ?? match.channel.id) : where,
    ts: match.ts,
    title: `${ctx.fromName} · ${where}: ${head}`,
    summary: truncate(named(text), 140),
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
      prUrl: findPrUrl(text),
    },
    mentionsMe: via === "mention",
  }
}
