import { Context, Deferred, Duration, Effect, Layer, Option, SynchronizedRef } from "effect"
import { ActionQueue } from "../actions/queue.ts"
import type { AdapterError } from "../domain/errors.ts"
import type { Session } from "../domain/session.ts"
import { Hub } from "../hub.ts"
import { truncate } from "../lib/text.ts"
import { Store } from "../store/store.ts"
import { SessionRepo } from "./repo.ts"

const ASK_TIMEOUT = Duration.minutes(30)

/**
 * The agent's `ask` tool: an answer card in "Needs you" and a reply the tool
 * call waits for. The session reads `waiting` meanwhile, but its SDK process is
 * still alive (and holds its slot) until the answer, a timeout, or a stop.
 */
export interface AsksShape {
  /**
   * Puts the card up and waits: the reply, or `undefined` after 30 minutes. The card lasts as long as the
   * call: interrupted with its turn (a stop, a crash, the daemon quitting), the card goes and the session
   * reads `running` again, as an interrupted turn does.
   */
  readonly ask: (session: Session, question: string, options: ReadonlyArray<string>) => Effect.Effect<string | undefined>
  /** The answer card's button: hands the reply to the blocked call (the caller removes the card). False when nobody waits on it. */
  readonly answer: (actionId: string, text: string) => Effect.Effect<boolean, AdapterError>
  /** Dismisses the question without treating the generated continuation as a user statement. */
  readonly dismiss: (actionId: string) => Effect.Effect<boolean, AdapterError>
  /** Your message to a session blocked on `ask` answers it, card and all. False when the session asked nothing. */
  readonly answerSession: (sessionId: string, text: string) => Effect.Effect<boolean, AdapterError>
}

export class Asks extends Context.Service<Asks, AsksShape>()("Asks") {}

interface Pending {
  readonly actionId: string
  readonly sessionId: string
  readonly question: string
  readonly reply: Deferred.Deferred<string | undefined>
}

export const AsksLive = Layer.effect(Asks)(
  Effect.gen(function* () {
    const repo = yield* SessionRepo
    const queue = yield* ActionQueue
    const store = yield* Store
    const hub = yield* Hub
    /** By answer-card id. */
    const pending = yield* SynchronizedRef.make<ReadonlyMap<string, Pending>>(new Map())

    /** Removes and returns the calls `pick` selects, so exactly one path (answer, timeout, interruption) completes each. */
    const take = (pick: (waiting: Pending) => boolean) =>
      SynchronizedRef.modify(pending, (current): readonly [ReadonlyArray<Pending>, ReadonlyMap<string, Pending>] => {
        const taken = [...current.values()].filter(pick)
        return [taken, new Map([...current].filter(([, waiting]) => !pick(waiting)))]
      })

    /** Back to `running`, only from the `waiting` the ask set: a session that moved on since keeps its status. */
    const resume = (sessionId: string, activity: string) =>
      repo.modify(sessionId, (current) => (current.status === "waiting" ? { ...current, status: "running", activity } : undefined))

    const reply = (waiting: Pending, response: { readonly kind: "answered"; readonly text: string } | { readonly kind: "dismissed" }) =>
      Effect.gen(function* () {
        const text = response.kind === "answered" ? response.text : "(The user dismissed the question. Proceed on your best judgement.)"
        yield* Deferred.succeed(waiting.reply, text)
        yield* repo.log(waiting.sessionId, "status", `You answered: ${text}`)
        if (response.kind === "answered") yield* store.captureMemory("user", `bridgetown:session/${waiting.sessionId}`, JSON.stringify({ question: waiting.question, answer: response.text }))
          .pipe(Effect.catch((error) => hub.problem("memory", error.message)))
        yield* resume(waiting.sessionId, "Continuing with your answer")
      })

    /** Nobody answered: the card goes, and the session is back to `running`. */
    const unanswered = (waiting: Pending) =>
      queue.remove(waiting.actionId).pipe(Effect.andThen(resume(waiting.sessionId, "No answer — continuing")), Effect.asVoid)

    const open = (session: Session, question: string, options: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const card = yield* queue.put({
          kind: "answer",
          title: question,
          detail: session.title,
          primaryLabel: "Reply",
          options: [...options],
          sessionId: session.id,
          alertId: session.alertId,
        })
        const waiting: Pending = { actionId: card.id, sessionId: session.id, question, reply: yield* Deferred.make<string | undefined>() }
        yield* SynchronizedRef.update(pending, (current) => new Map([...current, [card.id, waiting]]))
        return waiting
      })

    const ask = Effect.fn("Asks.ask")(
      function* (session: Session, question: string, options: ReadonlyArray<string>) {
        // Still open when the call ends (its turn was interrupted), the question goes unanswered.
        const waiting = yield* Effect.acquireRelease(open(session, question, options), (waiting) =>
          take((w) => w.actionId === waiting.actionId).pipe(
            Effect.flatMap((taken) => (taken.length === 0 ? Effect.void : unanswered(waiting))),
            Effect.ignore,
          ),
        )
        const activity = `Asked: ${truncate(question, 100)}`
        yield* repo.modify(session.id, (current) => (current.status === "running" ? { ...current, status: "waiting", activity } : undefined))
        yield* repo.log(session.id, "status", `Asked: ${question}`)
        const answered = yield* Deferred.await(waiting.reply).pipe(Effect.timeoutOption(ASK_TIMEOUT))
        if (Option.isSome(answered)) return answered.value
        // Timed out, unless an answer got there first.
        if ((yield* take((w) => w.actionId === waiting.actionId)).length === 0) return yield* Deferred.await(waiting.reply)
        yield* unanswered(waiting)
        return undefined
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed(undefined)),
    )

    return {
      ask,
      answer: (actionId, text) =>
        Effect.gen(function* () {
          const [waiting] = yield* take((w) => w.actionId === actionId)
          if (waiting === undefined) return false
          yield* reply(waiting, { kind: "answered", text })
          return true
        }),
      dismiss: (actionId) =>
        Effect.gen(function* () {
          const [waiting] = yield* take((w) => w.actionId === actionId)
          if (waiting === undefined) return false
          yield* reply(waiting, { kind: "dismissed" })
          return true
        }),
      answerSession: (sessionId, text) =>
        Effect.gen(function* () {
          const taken = yield* take((w) => w.sessionId === sessionId)
          for (const waiting of taken) {
            yield* queue.remove(waiting.actionId)
            yield* reply(waiting, { kind: "answered", text })
          }
          return taken.length > 0
        }),
    }
  }),
)
