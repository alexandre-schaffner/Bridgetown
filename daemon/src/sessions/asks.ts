import { Context, Deferred, Duration, Effect, Layer, Option, SynchronizedRef } from "effect"
import { ActionQueue } from "../actions/queue.ts"
import type { AdapterError } from "../domain/errors.ts"
import type { Session } from "../domain/model.ts"
import { truncate } from "../slack/text.ts"
import { SessionRepo } from "./repo.ts"

const ASK_TIMEOUT = Duration.minutes(30)

/**
 * The agent's `ask` tool: an answer card in "Needs you" and a reply the tool
 * call waits for. The session reads `waiting` meanwhile, but its SDK process is
 * still alive (and holds its slot) until the answer, a timeout, or a stop.
 */
export interface AsksShape {
  /** Puts the card up and waits: the reply, or `undefined` after 30 minutes or a stop. */
  readonly ask: (session: Session, question: string, options: ReadonlyArray<string>) => Effect.Effect<string | undefined>
  /** The answer card's button: hands the reply to the blocked call (the caller removes the card). False when nobody waits on it. */
  readonly answer: (actionId: string, text: string) => Effect.Effect<boolean, AdapterError>
  /** Your message to a session blocked on `ask` answers it, card and all. False when the session asked nothing. */
  readonly answerSession: (sessionId: string, text: string) => Effect.Effect<boolean, AdapterError>
  /** Unblocks every call of the session with "no answer" (it was stopped). */
  readonly cancelFor: (sessionId: string) => Effect.Effect<void>
}

export class Asks extends Context.Service<Asks, AsksShape>()("Asks") {}

interface Pending {
  readonly actionId: string
  readonly sessionId: string
  readonly reply: Deferred.Deferred<string | undefined>
}

export const AsksLive = Layer.effect(Asks)(
  Effect.gen(function* () {
    const repo = yield* SessionRepo
    const queue = yield* ActionQueue
    /** By answer-card id. */
    const pending = yield* SynchronizedRef.make<ReadonlyMap<string, Pending>>(new Map())

    /** Removes and returns the calls `pick` selects, so exactly one path (answer, timeout, stop) completes each. */
    const take = (pick: (waiting: Pending) => boolean) =>
      SynchronizedRef.modify(pending, (current): readonly [ReadonlyArray<Pending>, ReadonlyMap<string, Pending>] => {
        const taken = [...current.values()].filter(pick)
        return [taken, new Map([...current].filter(([, waiting]) => !pick(waiting)))]
      })

    const reply = (waiting: Pending, text: string) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(waiting.reply, text)
        yield* repo.log(waiting.sessionId, "status", `You answered: ${text}`)
        yield* repo.patch(waiting.sessionId, { status: "running", activity: "Continuing with your answer" })
      })

    const ask = Effect.fn("Asks.ask")(function* (session: Session, question: string, options: ReadonlyArray<string>) {
      const card = yield* queue.put({
        kind: "answer",
        title: question,
        detail: session.title,
        primaryLabel: "Reply",
        options: [...options],
        sessionId: session.id,
        alertId: session.alertId,
        payload: null,
      })
      const waiting: Pending = { actionId: card.id, sessionId: session.id, reply: yield* Deferred.make<string | undefined>() }
      yield* SynchronizedRef.update(pending, (current) => new Map([...current, [card.id, waiting]]))
      yield* repo.patch(session.id, { status: "waiting", activity: `Asked: ${truncate(question, 100)}` })
      yield* repo.log(session.id, "status", `Asked: ${question}`)
      const answered = yield* Deferred.await(waiting.reply).pipe(Effect.timeoutOption(ASK_TIMEOUT))
      if (Option.isSome(answered)) return answered.value
      // Timed out, unless an answer got there first.
      if ((yield* take((w) => w.actionId === card.id)).length === 0) return yield* Deferred.await(waiting.reply)
      yield* queue.remove(card.id)
      yield* repo.patch(session.id, { status: "running", activity: "No answer — continuing" })
      return undefined
    }, Effect.catch(() => Effect.succeed(undefined)))

    return {
      ask,
      answer: (actionId, text) =>
        Effect.gen(function* () {
          const [waiting] = yield* take((w) => w.actionId === actionId)
          if (waiting === undefined) return false
          yield* reply(waiting, text)
          return true
        }),
      answerSession: (sessionId, text) =>
        Effect.gen(function* () {
          const taken = yield* take((w) => w.sessionId === sessionId)
          for (const waiting of taken) {
            yield* queue.remove(waiting.actionId)
            yield* reply(waiting, text)
          }
          return taken.length > 0
        }),
      cancelFor: (sessionId) =>
        take((w) => w.sessionId === sessionId).pipe(
          Effect.flatMap((taken) => Effect.forEach(taken, (waiting) => Deferred.succeed(waiting.reply, undefined), { discard: true })),
        ),
    }
  }),
)
