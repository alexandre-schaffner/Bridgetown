import type { AlertSource, EngineFields, ParsedAlert, ReleaseFields, Stage, StageStatus, UptimeFields, UptimeState } from "../domain/alert.ts"
import { releaseHeadline, releaseState } from "../domain/release.ts"
import type { SlackMessage } from "./client.ts"
import { firstLine, truncate } from "../lib/text.ts"
import { clean, flattenMessage, plain, stripEmoji } from "./text.ts"

/** Raw text handed to Jev and to agents. Engine alerts embed whole XDR envelopes. */
const RAW_LIMIT = 4_000

const STATUS_BY_EMOJI: Record<string, StageStatus> = {
  white_circle: "pending",
  large_yellow_circle: "in_progress",
  large_green_circle: "success",
  red_circle: "failure",
}

const EMOJI = "(white_circle|large_yellow_circle|large_green_circle|red_circle)"
const STAGE_HEADER = new RegExp(`^:${EMOJI}:\\s+\\*([^*]+)\\*\\s*$`)
const SUBSTAGE = new RegExp(`^↳\\s*:${EMOJI}:\\s*\\*([^*]+)\\*\\s*[—-]\\s*(.*)$`)

/**
 * Walks the tracker's cells in order. A cell is a status-light header line
 * followed by its status lines; an environment with several apps carries
 * `↳` sub-rows instead, and those become the stages.
 */
const parseStages = (text: string): ReadonlyArray<Stage> => {
  const stages: Array<Stage> = []
  let current: { name: string; status: StageStatus; detail: Array<string>; subs: number } | undefined
  const flush = () => {
    if (current !== undefined && current.subs === 0) {
      stages.push({ name: current.name, status: current.status, detail: plain(current.detail.join(" · ")) })
    }
    current = undefined
  }
  for (const line of text.split("\n").map((l) => l.trim())) {
    const header = STAGE_HEADER.exec(line)
    if (header !== null) {
      flush()
      current = { name: (header[2] ?? "").trim(), status: STATUS_BY_EMOJI[header[1] ?? ""] ?? "pending", detail: [], subs: 0 }
      continue
    }
    const sub = SUBSTAGE.exec(line)
    if (sub !== null && current !== undefined) {
      stages.push({
        name: `${current.name} › ${(sub[2] ?? "").trim()}`,
        status: STATUS_BY_EMOJI[sub[1] ?? ""] ?? "pending",
        detail: plain((sub[3] ?? "").replace(/<[^>]+>/g, "").trim()),
      })
      current.subs += 1
      continue
    }
    if (line.startsWith("*`")) {
      flush()
      continue
    }
    if (current !== undefined && line !== "" && !line.startsWith("<") && current.detail.length < 2) {
      current.detail.push(line.replace(/_/g, "").replace(/\s+·\s+/g, " · "))
    }
  }
  flush()
  return stages
}

const stageSummary = (stages: ReadonlyArray<Stage>): string =>
  stages
    .map((s) => {
      const mark = s.status === "success" ? "✓" : s.status === "failure" ? "✗" : "…"
      const tally = /(\d+ attempts? failed)/.exec(s.detail)?.[1]
      return `${s.name} ${mark}${tally === undefined ? "" : ` (${tally})`}`
    })
    .join(" · ")

const parseRelease = (text: string): ReleaseFields | undefined => {
  const fallback = /Deployment\s+(\S+)\s+(v\d[\w.\-+]*)/.exec(text)
  const lines = text.split("\n").map((line) => line.trim())
  const versionMatch = /\*`(v[^`]+)`\*/.exec(text)
  const image = fallback?.[1] ?? lines.find((line) => /^merkl[\w-]*$/.test(line))
  const version = versionMatch?.[1] ?? fallback?.[2]
  const stages = parseStages(text)
  if (image === undefined || version === undefined || stages.length === 0) return undefined
  const run = /<(https:\/\/[^|>]+\/actions\/runs\/(\d+))\|Run>/.exec(text)
  const tag = /\/releases\/tag\/([^|>]+)\|Release notes>/.exec(text)
  const actor = /^by\s+([\w.-]+)/m.exec(text)
  return {
    _tag: "release",
    image,
    version,
    actor: actor?.[1] ?? null,
    runId: run?.[2] ?? null,
    runUrl: run?.[1] ?? null,
    tag: tag?.[1] ?? null,
    stages,
  }
}

const uptimeState = (text: string): UptimeState => {
  if (/incident resolved/i.test(text)) return "resolved"
  if (/incident started/i.test(text)) return "incident"
  if (/degraded performance.*has ended/i.test(text)) return "recovered"
  if (/degraded performance/i.test(text)) return "degraded"
  if (/ssl certificate/i.test(text)) return "ssl_expiry"
  if (/\b(is up|back up|recovered)\b/i.test(text)) return "recovered"
  if (/\b(is down|went down)\b/i.test(text)) return "incident"
  return "other"
}

const UPTIME_TITLES: Record<UptimeState, string> = {
  incident: "Incident started",
  resolved: "Incident resolved",
  degraded: "Degraded performance",
  recovered: "Performance recovered",
  ssl_expiry: "SSL certificate expiring",
  other: "Uptime notice",
}

const parseUptime = (text: string): UptimeFields => {
  const link = /<(?:https?:\/\/)?[^|>]+\|([^>]+)>/.exec(text)?.[1]
  const bare = /\b((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s*>]*)?)/i.exec(plain(text))?.[1]
  const target = (link ?? bare ?? "unknown").replace(/\*+$/, "").replace(/^https?:\/\//, "")
  return { _tag: "uptime", target, state: uptimeState(text) }
}

const normalizeError = (error: string): string =>
  error
    .replace(/\{.*$/s, "")
    .replace(/0x[0-9a-f]+|[0-9a-f]{16,}/gi, "#")
    .replace(/\d+/g, "#")
    .trim()
    .slice(0, 80)

const parseEngine = (text: string): EngineFields | undefined => {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "")
  const errorLine = lines.find((line) => /^:(x|skull|warning|rotating_light):/.test(line) || /error/i.test(line))
  if (errorLine === undefined) return undefined
  const subject = stripEmoji(clean(lines.find((line) => line !== errorLine) ?? "Engine job"))
  const txHash = /"txHash":"([0-9a-f]{64})"/.exec(text)?.[1] ?? null
  return { _tag: "engine", subject, error: truncate(stripEmoji(clean(errorLine)), 300), txHash }
}

const sourceFor = (channelName: string): AlertSource => {
  if (channelName === "alert-releases") return "releases"
  if (channelName === "alert-uptime") return "uptime"
  if (channelName === "alert-engine") return "engine"
  return "generic"
}

export interface ParseContext {
  readonly channelId: string
  readonly channelName: string
  readonly myUserId: string | undefined
}

export const parseMessage = (message: SlackMessage, ctx: ParseContext): ParsedAlert => {
  const text = flattenMessage(message)
  const raw = truncate(text, RAW_LIMIT)
  const base = {
    id: `${ctx.channelId}:${message.ts}`,
    channelId: ctx.channelId,
    channelName: ctx.channelName,
    ts: message.ts,
    raw,
    mentionsMe: ctx.myUserId !== undefined && (text.includes(`<@${ctx.myUserId}>`) || text.includes(`<@${ctx.myUserId}|`)),
  }
  const source = sourceFor(ctx.channelName)

  const release = source === "releases" || /^Deployment\s+\S+\s+v\d/.test(text) ? parseRelease(text) : undefined
  if (release !== undefined) {
    return {
      ...base,
      source: "releases",
      title: `${release.image} ${release.version} · ${releaseHeadline(releaseState(release.stages))}`,
      summary: stageSummary(release.stages),
      fingerprint: `release:${release.image}:${release.version}`,
      fields: release,
    }
  }

  if (source === "uptime") {
    const uptime = parseUptime(text)
    return {
      ...base,
      source,
      title: `${UPTIME_TITLES[uptime.state]} · ${uptime.target}`,
      summary: truncate(stripEmoji(clean(firstLine(text))), 140),
      fingerprint: `uptime:${uptime.state === "ssl_expiry" ? "ssl:" : ""}${uptime.target}`,
      fields: uptime,
    }
  }

  const engine = source === "engine" ? parseEngine(text) : undefined
  if (engine !== undefined) {
    return {
      ...base,
      source,
      title: `${engine.subject} · ${truncate(engine.error.replace(/^failed to /i, "Failed to "), 70)}`,
      summary: truncate(engine.error, 140),
      fingerprint: `engine:${engine.subject}:${normalizeError(engine.error)}`,
      fields: engine,
    }
  }

  const head = stripEmoji(clean(firstLine(text)))
  return {
    ...base,
    source: "generic",
    title: truncate(head === "" ? `Message in #${ctx.channelName}` : head, 90),
    summary: truncate(stripEmoji(clean(text.split("\n").filter((line) => line.trim() !== "" && clean(line) !== head).slice(0, 3).join(" · "))), 140),
    fingerprint: `generic:${ctx.channelName}:${normalizeError(head)}`,
    fields: { _tag: "generic" },
  }
}
