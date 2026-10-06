/**
 * Calibration: run the parser, rules and Jev over real alert history and print
 * what Bridgetown would have done. Nothing is stored, started or posted.
 *
 *   bun scripts/replay.ts --channel alert-releases --since 14d      (needs SLACK_USER_TOKEN)
 *   bun scripts/replay.ts --file messages.json                      ([{ channel, ts, text }])
 */
import { Effect, Schema } from "effect"
import { DEFAULT_SETTINGS, readEnv } from "../src/config.ts"
import { type Alert, alertFromParsed, type Decision, type ThreadReply } from "../src/domain/alert.ts"
import type { Session } from "../src/domain/session.ts"
import { makeSlackClient, type SlackMessage } from "../src/slack/client.ts"
import { parseMessage } from "../src/slack/parse.ts"
import { now } from "../src/domain/ids.ts"
import { makeJev } from "../src/triage/jev.ts"
import { decide } from "../src/triage/policy.ts"
import { applyRules } from "../src/triage/rules.ts"

const ReplayFile = Schema.Array(
  Schema.Struct({
    channel: Schema.String,
    ts: Schema.String,
    text: Schema.String,
    thread: Schema.optional(Schema.Array(Schema.Struct({ author: Schema.Literals(["bot", "me", "teammate"]), text: Schema.String }))),
  }),
)

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(4)

const env = readEnv()
const jev = makeJev(env.typesafeKey, env.jevModel)
const thresholds = DEFAULT_SETTINGS.thresholds

interface Item {
  readonly channel: string
  readonly message: SlackMessage
  readonly thread: ReadonlyArray<ThreadReply>
}

const load = Effect.gen(function* () {
  const file = arg("file")
  if (file !== undefined) {
    const rows = Schema.decodeUnknownSync(ReplayFile)(yield* Effect.promise(() => Bun.file(file).json()))
    return rows.map((row): Item => ({ channel: row.channel, message: { ts: row.ts, text: row.text, bot_id: "B" }, thread: row.thread ?? [] }))
  }
  const name = arg("channel") ?? "alert-releases"
  const channel = DEFAULT_SETTINGS.channels.find((c) => c.name === name)
  if (channel === undefined) return yield* Effect.die(`unknown channel ${name}`)
  const days = Number((arg("since") ?? "14d").replace("d", ""))
  const slack = makeSlackClient(env.slackToken)
  const oldest = String(Date.now() / 1000 - days * 86_400)
  const messages = yield* slack.latest(channel.id, 200, oldest)
  return messages.map((message): Item => ({ channel: name, message, thread: [] }))
})

const program = Effect.gen(function* () {
  const items = yield* load
  const seen: Array<Alert> = []
  const counts: Partial<Record<Decision, number>> = {}
  for (const item of [...items].reverse()) {
    const parsed = parseMessage(item.message, { channelId: item.channel, channelName: item.channel, myUserId: undefined })
    const history = seen.filter((a) => a.fingerprint === parsed.fingerprint)
    const rule = applyRules(parsed, { activeSessions: new Array<Session>(), sameFingerprint: history, claimedBy: [] })
    let line: string
    let decision: Decision
    if (rule._tag !== "Judge") {
      decision = "filtered"
      line = `filtered  ${rule.reason}`
    } else {
      const verdict = yield* jev.judge({
        alert: parsed,
        thread: item.thread,
        reactions: [],
        history,
      })
      const d = decide(verdict, thresholds)
      decision = d.decision
      line = `${d.decision.padEnd(9)} act ${pct(verdict.actionable)} · agent ${pct(verdict.agentResolvable)} · human ${pct(verdict.humanOnIt)} · ${verdict.kind} (${pct(verdict.kindConfidence)}) · ${verdict.depth} · urgency ${verdict.urgency.toFixed(1)}`
    }
    counts[decision] = (counts[decision] ?? 0) + 1
    seen.push(alertFromParsed(parsed, { permalink: null, receivedAt: now(), triage: { decision, reason: "", jev: null }, sessionId: null, events: [] }))
    console.log(`${line}\n          #${item.channel} · ${parsed.title}\n`)
  }
  console.log(counts)
})

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
