/** Calibration for inbox triage: `bun scripts/replay-inbox.ts <file.json>` with [{ from, where, kind, text, thread? }]. */
import { Effect, Schema } from "effect"
import { DEFAULT_SETTINGS, readEnv } from "../src/config.ts"
import { parseInbox } from "../src/slack/inbox.ts"
import { makeJev } from "../src/triage/jev.ts"
import { decideInbox } from "../src/triage/policy.ts"

const Items = Schema.Array(
  Schema.Struct({
    from: Schema.String,
    where: Schema.String,
    via: Schema.Literals(["mention", "group", "dm"]),
    text: Schema.String,
    thread: Schema.optional(Schema.Array(Schema.Struct({ author: Schema.Literals(["bot", "me", "teammate"]), text: Schema.String }))),
  }),
)

const env = readEnv()
const jev = makeJev(env.typesafeKey, env.jevModel)
const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(4)

const program = Effect.gen(function* () {
  const items = Schema.decodeUnknownSync(Items)(yield* Effect.promise(() => Bun.file(process.argv[2] ?? "").json()))
  for (const [index, item] of items.entries()) {
    const parsed = parseInbox(
      {
        ts: `${1790900000 + index}.000100`,
        text: item.text,
        user: "UOTHER",
        channel: { id: `C${index}`, name: item.where.replace("#", ""), is_im: item.where === "DM" },
      },
      item.via,
      { me: "U0ATSF15M4L", fromName: item.from, alertChannels: new Set() },
    )
    if (parsed === undefined) continue
    const verdict = yield* jev.judgeInbox({ item: parsed, thread: item.thread ?? [], myName: "Alexandre Schaffner" })
    const decision = decideInbox(verdict, DEFAULT_SETTINGS.thresholds)
    console.log(
      `${decision.decision.padEnd(9)} needs ${pct(verdict.actionable)} · agent ${pct(verdict.agentResolvable)} · done ${pct(verdict.humanOnIt)} · ${verdict.kind} · ${verdict.depth}\n          ${parsed.title}\n`,
    )
  }
})

await Effect.runPromise(program)
