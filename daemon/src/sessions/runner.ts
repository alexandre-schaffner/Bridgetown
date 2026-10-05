import { Context, Effect, Fiber, FiberMap, FiberSet, Layer, Option, Queue, SynchronizedRef } from "effect"
import { ActionQueue } from "../actions/queue.ts"
import { MAX_CRITIQUE_ROUNDS } from "../critique/transitions.ts"
import { type AdapterError, Conflict, errorMessage, NotFound } from "../domain/errors.ts"
import { newId, now } from "../domain/ids.ts"
import { acceptsMessages, type Alert, holdsSlot, isActive, isFinished, type Session } from "../domain/model.ts"
import { Hub } from "../hub.ts"
import { GitHub } from "../ship/github.ts"
import { SlackThread } from "../slack/thread.ts"
import { Store } from "../store/store.ts"
import { alertKind } from "../triage/kind.ts"
import { Agent } from "./agent.ts"
import { Asks } from "./asks.ts"
import { makeFinish } from "./finish.ts"
import { inboxPrompt, initialPrompt, RETRY_PROMPT, setupNotes } from "./prompts.ts"
import { SessionRepo, withPatch } from "./repo.ts"
import type { TurnEnd } from "./sdk-events.ts"
import { makeTurnInput, makeTurns, type TurnInput, userMessage } from "./turn.ts"
import { newSession } from "./new-session.ts"
import { createWorktree } from "./worktree.ts"

/** What Bridgetown may set along with a turn it asks for (CI round, review handled, what it is sent back for…). Status is the runner's. */
export type TurnPatch = Partial<Pick<Session, "phase" | "activity" | "ciRounds" | "review" | "deployStage" | "sentBack">>

/**
 * What happened to a message or prompt: sent into the running turn (the agent
 * reads it at its next step), queued for after the turn, started as a new turn,
 * parked until an agent slot frees up, or refused because the session does not
 * take messages (`acceptsMessages`) or is finished.
 */
export type Delivery = "sent" | "queued" | "started" | "parked" | "refused"

export interface SessionRunnerShape {
  /** Creates a queued session for the alert; `tick` starts it when a slot frees up. */
  readonly enqueue: (alert: Alert) => Effect.Effect<Session, AdapterError>
  /** Starts parked turns, then queued sessions, as far as `maxConcurrent` allows. */
  readonly tick: Effect.Effect<void, AdapterError>
  /** Another turn on Bridgetown's behalf (CI red, requested changes, a failed deploy, a teammate's follow-up). Never reopens a finished session. */
  readonly continueWith: (sessionId: string, prompt: string, patch?: TurnPatch) => Effect.Effect<Delivery, AdapterError>
  /** Your message: answers a pending `ask`, else reaches the agent. `Conflict` unless the session `acceptsMessages`; may resume a handed-back session. */
  readonly message: (sessionId: string, text: string) => Effect.Effect<void, AdapterError | NotFound | Conflict>
  readonly stop: (sessionId: string) => Effect.Effect<void, AdapterError | NotFound>
  /** Re-queues a failed session; it resumes its agent conversation if it had one. `Conflict` while its last turn is still winding down. */
  readonly retry: (sessionId: string) => Effect.Effect<void, AdapterError | Conflict>
  /** Hands the user's reply to a blocked `ask` call. False when nobody is waiting on that action. */
  readonly answer: (actionId: string, text: string) => Effect.Effect<boolean, AdapterError>
  /** A turn is running or parked for a slot: the ship loop leaves the session alone. */
  readonly busy: (sessionId: string) => Effect.Effect<boolean>
}

export class SessionRunner extends Context.Service<SessionRunner, SessionRunnerShape>()("SessionRunner") {}

interface FollowUp {
  readonly text: string
  readonly reopen: boolean
}

/** A session with an SDK query alive: its current turn's input, and what waits for the next, resumed turn. */
interface Live {
  readonly input: TurnInput
  readonly followUps: Queue.Queue<FollowUp>
}

/** A turn waiting for an agent slot. */
interface Parked {
  readonly texts: ReadonlyArray<string>
  readonly patch: TurnPatch
  readonly reopen: boolean
}

/** Every delivery decision and every turn hand-over reads and writes this under one lock, so a message is never lost between turns. */
interface Turns {
  readonly live: ReadonlyMap<string, Live>
  readonly parked: ReadonlyMap<string, Parked>
}

interface Claim {
  /** Resume the agent's conversation. */
  readonly resume: boolean
  readonly patch?: TurnPatch
  /** Your message to a finished, handed-back session may reopen it; nothing else may. */
  readonly reopen?: boolean
  /** The first turn after `start` prepared the worktree. */
  readonly fromStart?: boolean
}

interface Claimed {
  readonly session: Session
  readonly input: TurnInput
  readonly followUps: Queue.Queue<FollowUp>
  readonly resume: boolean
}

/** Messages around an alert that go straight into the first prompt; `slack_context` reaches further. */
const NEARBY_MINUTES = 10

const withLive = (turns: Turns, id: string, live: Live | undefined): Turns => {
  const next = new Map(turns.live)
  if (live === undefined) next.delete(id)
  else next.set(id, live)
  return { ...turns, live: next }
}

const withParked = (turns: Turns, id: string, parked: Parked | undefined): Turns => {
  const next = new Map(turns.parked)
  if (parked === undefined) next.delete(id)
  else next.set(id, parked)
  return { ...turns, parked: next }
}

export const SessionRunnerLive = Layer.effect(SessionRunner)(
  Effect.gen(function* () {
    const store = yield* Store
    const hub = yield* Hub
    const thread = yield* SlackThread
    const repo = yield* SessionRepo
    const queue = yield* ActionQueue
    const asks = yield* Asks
    const agent = yield* Agent
    const github = yield* GitHub

    const turns = yield* SynchronizedRef.make<Turns>({ live: new Map(), parked: new Map() })
    /** One fiber per session (preparing its worktree, or driving its turns), interrupted by a stop or when the layer shuts down. */
    const fibers = yield* FiberMap.make<string>()
    /** The SDK tool callbacks' Promise boundary; what it runs is interrupted with the layer too. */
    const runPromise = yield* FiberSet.makeRuntimePromise()
    // Parked turns and queued follow-ups only live here: when the daemon stops, the transcript says they went undelivered.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const state = yield* SynchronizedRef.get(turns)
        for (const id of state.parked.keys()) yield* repo.log(id, "status", "Not delivered: Bridgetown quit while it waited for an agent slot")
        for (const [id, live] of state.live) {
          if ((yield* Queue.size(live.followUps)) > 0) yield* repo.log(id, "status", "Not delivered: Bridgetown quit before the current turn ended")
        }
      }).pipe(Effect.ignore),
    )

    const freeSlots = (state: Turns) =>
      Effect.gen(function* () {
        const settings = yield* hub.settings
        const live = new Set(state.live.keys())
        return settings.maxConcurrent - (yield* store.activeSessions()).filter((s) => holdsSlot(s, live)).length
      })

    const { finishFailed, finalize } = makeFinish({ store, thread, repo, queue, github, hub, sendBack: (id, prompt) => deliver(id, prompt, {}, false) })

    const { runTurn } = makeTurns({
      store,
      hub,
      thread,
      repo,
      asks,
      agent,
      runPromise,
      onEnd: (id) => (end: TurnEnd) => (end._tag === "Failed" ? finishFailed(id, end.reason) : finalize(id, end.result)),
      onFailure: (id, reason) => finishFailed(id, reason).pipe(Effect.ignore),
    })

    /**
     * Under the lock: the guarded write that makes the session `running` (a stop
     * that landed during any earlier await wins, and nothing starts in a removed
     * worktree) and its live entry with the turn's input.
     */
    const claim = (state: Turns, id: string, prompt: string, options: Claim) =>
      Effect.gen(function* () {
        const session = yield* repo.modify(
          id,
          (current) => {
            const allowed =
              options.fromStart === true ? current.status === "preparing" && current.worktree !== null : acceptsMessages(current)
            if (!allowed) return undefined
            return {
              ...withPatch(current, options.patch ?? {}),
              status: "running",
              activity: options.patch?.activity ?? (options.resume ? "Resuming…" : "Agent started"),
            }
          },
          { evenIfFinished: options.reopen === true },
        )
        if (session === undefined) return [undefined, state] as const
        const input = yield* makeTurnInput(prompt)
        const followUps = state.live.get(id)?.followUps ?? (yield* Queue.unbounded<FollowUp>())
        const claimed: Claimed = { session, input, followUps, resume: options.resume }
        return [claimed, withLive(state, id, { input, followUps })] as const
      })

    /** Removes the session's live entry, unless a newer drive already replaced it. */
    const dropLive = (state: Turns, id: string, followUps: Queue.Queue<FollowUp>) =>
      state.live.get(id)?.followUps === followUps ? withLive(state, id, undefined) : state

    /**
     * Under the lock, when a turn ended: its follow-ups become the next turn, or
     * the live entry goes. A message is either queued before this runs (and
     * picked up here) or finds no live entry and starts its own turn; never neither.
     */
    const handOver = (id: string, followUps: Queue.Queue<FollowUp>): Effect.Effect<Claimed | undefined> =>
      SynchronizedRef.modifyEffect(turns, (state) =>
        Effect.gen(function* () {
          const waiting = yield* Queue.clear(followUps)
          if (waiting.length === 0) return [undefined, dropLive(state, id, followUps)] as const
          const reopen = waiting.some((f) => f.reopen)
          const [next, after] = yield* claim(state, id, waiting.map((f) => f.text).join("\n\n"), { resume: true, reopen })
          if (next !== undefined) return [next, after] as const
          yield* repo.log(id, "status", "Follow-up not delivered: the session has ended")
          return [undefined, dropLive(state, id, followUps)] as const
        }).pipe(
          Effect.catch((error) =>
            finishFailed(id, error.message).pipe(Effect.ignore, Effect.as([undefined, dropLive(state, id, followUps)] as const)),
          ),
        ),
      )

    /** Runs the session's turns, one after the other, until no follow-up is waiting. */
    const drive = (id: string, first: Claimed): Effect.Effect<void> =>
      Effect.gen(function* () {
        let turn: Claimed | undefined = first
        while (turn !== undefined) {
          yield* runTurn(id, turn.session, turn.input, turn.resume)
          turn = yield* handOver(id, first.followUps)
        }
      }).pipe(Effect.ensuring(SynchronizedRef.update(turns, (state) => dropLive(state, id, first.followUps))))

    /** Claims under the lock, then drives the turns on the session's fiber. Returns whether a turn started. */
    const startTurn = (state: Turns, id: string, prompt: string, options: Claim) =>
      Effect.gen(function* () {
        const [claimed, after] = yield* claim(state, id, prompt, options)
        if (claimed !== undefined) yield* FiberMap.run(fibers, id, drive(id, claimed))
        return [claimed !== undefined, after] as const
      })

    const start = (claimed: Session) =>
      Effect.gen(function* () {
        const id = claimed.id
        yield* repo.log(id, "status", `Fetching origin/main and creating worktree on ${claimed.branch ?? "?"} (then bun install)…`)
        const { path: worktree, warnings } = yield* createWorktree(claimed.repoPath, claimed.branch ?? "")
        yield* repo.log(id, "status", `Worktree ready: ${worktree}`)
        for (const warning of warnings) yield* repo.log(id, "error", `Setup: ${warning}`)
        const upgrade = warnings.find((w) => w.includes("bun upgrade"))
        if (upgrade !== undefined) yield* hub.patchStatus({ error: upgrade })
        const ready = yield* repo.modify(id, (current) => (current.status === "preparing" ? { ...current, worktree } : undefined))
        if (ready === undefined) return
        const prompt = yield* firstPrompt(ready, warnings)
        if (prompt === undefined) return
        // This fiber is already the session's: it drives the turns itself.
        const first = yield* SynchronizedRef.modifyEffect(turns, (state) => claim(state, id, prompt.text, { resume: prompt.resume, fromStart: true }))
        if (first !== undefined) yield* drive(id, first)
      }).pipe(
        Effect.catch((error) => finishFailed(claimed.id, `Could not start: ${error.message}`)),
        Effect.catchDefect((defect) => finishFailed(claimed.id, `Could not start: ${errorMessage(defect)}`)),
        Effect.ignore,
      )

    /** A retried session picks its conversation back up; a new one gets the alert. Its claim in Slack went out before it was queued (`Claims`). */
    const firstPrompt = (ready: Session, warnings: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (ready.claudeSessionId !== null) return { text: `${RETRY_PROMPT}${setupNotes(warnings)}`, resume: true }
        const alert = yield* store.getAlert(ready.alertId)
        if (alert === undefined) {
          yield* finishFailed(ready.id, "Its alert is gone")
          return undefined
        }
        const replies = yield* thread.replies(alert)
        const nearby = alert.fields._tag === "inbox" ? [] : yield* thread.nearby(alert, NEARBY_MINUTES)
        const prompt =
          alert.fields._tag === "inbox"
            ? inboxPrompt({ alert, fromName: alert.fields.fromName, where: alert.channelName, branch: ready.branch ?? "", thread: replies })
            : initialPrompt({
                alert,
                kind: alertKind(alert),
                branch: ready.branch ?? "",
                thread: replies,
                nearby,
                deploymentRepoPath: (yield* hub.settings).deploymentRepoPath,
              })
        if ((yield* repo.get(ready.id))?.status !== "preparing") return undefined
        return { text: `${prompt}${setupNotes(warnings)}`, resume: false }
      })

    /**
     * Delivers text to the session: into the running turn's input, behind it
     * when that turn already ended, as a new resumed turn, or parked until a slot
     * frees up. `acceptsMessages` is the one rule for whether it may reach the
     * agent at all; only your message may reopen a finished session.
     */
    const deliver = (id: string, text: string, patch: TurnPatch, reopen: boolean): Effect.Effect<Delivery, AdapterError> =>
      SynchronizedRef.modifyEffect(turns, (state) =>
        Effect.gen(function* () {
          const session = yield* repo.get(id)
          if (session === undefined) return ["refused", state] as const
          const live = state.live.get(id)
          if (live !== undefined) {
            // No claim will carry the patch: the text joins a turn that already has one.
            if (Object.keys(patch).length > 0) yield* repo.patch(id, patch)
            if (yield* Queue.offer(live.input, userMessage(text, "next"))) return ["sent", state] as const
            yield* Queue.offer(live.followUps, { text, reopen })
            yield* repo.log(id, "status", "Queued for after the current turn")
            return ["queued", state] as const
          }
          if (!acceptsMessages(session) || (isFinished(session) && !reopen)) return ["refused", state] as const
          const waiting = state.parked.get(id)
          if (waiting !== undefined) {
            const merged = { texts: [...waiting.texts, text], patch: { ...waiting.patch, ...patch }, reopen: waiting.reopen || reopen }
            return ["parked", withParked(state, id, merged)] as const
          }
          if ((yield* freeSlots(state)) <= 0) {
            yield* repo.log(id, "status", "Waiting for a free agent slot", { activity: true })
            return ["parked", withParked(state, id, { texts: [text], patch, reopen })] as const
          }
          const [started, after] = yield* startTurn(state, id, text, { resume: true, patch, reopen })
          return [started ? "started" : "refused", after] as const
        }),
      )

    /** Parked turns first (they were waiting already), as far as the free slots go. */
    const startParked = SynchronizedRef.modifyEffect(turns, (initial) =>
      Effect.gen(function* () {
        let state = initial
        let free = yield* freeSlots(state)
        for (const [id, turn] of initial.parked) {
          if (free <= 0) break
          state = withParked(state, id, undefined)
          const [started, after] = yield* startTurn(state, id, turn.texts.join("\n\n"), { resume: true, patch: turn.patch, reopen: turn.reopen }).pipe(
            Effect.catch((error) => finishFailed(id, error.message).pipe(Effect.as([false, state] as const))),
          )
          state = after
          if (started) free -= 1
          else yield* repo.log(id, "status", "Not delivered: the session no longer takes messages").pipe(Effect.ignore)
        }
        return [free, state] as const
      }),
    )

    return {
      enqueue: Effect.fn("SessionRunner.enqueue")(function* (alert: Alert) {
        const settings = yield* hub.settings
        const id = newId("s")
        const session = newSession(alert, id, settings.monorepoPath)
        yield* repo.create(session)
        yield* store.modifyAlert(alert.id, (current) => {
          const base = current ?? alert
          return { ...base, sessionId: id, events: [...base.events, { at: now(), text: `Agent session started (${session.model}, ${session.effort})` }] }
        })
        yield* hub.notify
        return session
      }),

      tick: Effect.gen(function* () {
        const free = yield* startParked
        if (free <= 0) return
        const queued = (yield* store.activeSessions()).filter((s) => s.status === "queued").sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        for (const session of queued.slice(0, free)) {
          const claimed = yield* repo.modify(session.id, (current) =>
            current.status === "queued" ? { ...current, status: "preparing", activity: "Creating worktree…" } : undefined,
          )
          if (claimed !== undefined) yield* FiberMap.run(fibers, claimed.id, start(claimed))
        }
      }),

      continueWith: (sessionId, prompt, patch = {}) => deliver(sessionId, prompt, patch, false),

      message: Effect.fn("SessionRunner.message")(function* (sessionId: string, text: string) {
        const session = yield* repo.get(sessionId)
        if (session === undefined) return yield* new NotFound({ message: "unknown session" })
        if (!acceptsMessages(session)) return yield* new Conflict({ message: `A ${session.status} session does not take messages` })
        // In the transcript at once, whatever happens next, so you see it was received.
        yield* repo.log(sessionId, "text", `You: ${text}`)
        // An agent blocked on `ask` is waiting for exactly this.
        if (yield* asks.answerSession(sessionId, text)) return
        // Review rounds spent: your message is the call to keep going, so the review gets a fresh budget.
        if (session.critiqueRounds >= MAX_CRITIQUE_ROUNDS) yield* repo.patch(sessionId, { critiqueRounds: 0 })
        const delivery = yield* deliver(sessionId, text, {}, true)
        if (delivery === "refused") return yield* new Conflict({ message: "The session no longer takes messages" })
        if (delivery === "sent") yield* repo.patch(sessionId, { activity: "Read your message" })
        if (delivery === "queued") yield* repo.patch(sessionId, { activity: "Message queued for after the current step" })
      }),

      retry: Effect.fn("SessionRunner.retry")(function* (sessionId: string) {
        // The failed turn has not let go of the session yet; the retry card stays for a second click.
        if ((yield* SynchronizedRef.get(turns)).live.has(sessionId)) return yield* new Conflict({ message: "The agent is still winding down; retry in a moment" })
        const retried = yield* repo.modify(
          sessionId,
          (current) => (current.status === "failed" ? { ...current, status: "queued", activity: "Retrying…", resolution: null } : undefined),
          { evenIfFinished: true },
        )
        if (retried !== undefined) yield* repo.log(sessionId, "status", "Retrying")
      }),

      stop: Effect.fn("SessionRunner.stop")(function* (sessionId: string) {
        const session = yield* repo.get(sessionId)
        if (session === undefined) return yield* new NotFound({ message: "unknown session" })
        if (!isActive(session)) return
        // Under the lock, so no delivery starts a turn in between: stopped first, which every later claim of
        // Bridgetown's respects, then nothing live or parked, and the fiber of whatever turn did start.
        const fiber = yield* SynchronizedRef.modifyEffect(turns, (state) =>
          Effect.gen(function* () {
            yield* repo.patch(sessionId, { status: "stopped", activity: "Stopped by you", resolution: "stopped by you" })
            const running = yield* FiberMap.get(fibers, sessionId)
            return [running, withParked(withLive(state, sessionId, undefined), sessionId, undefined)] as const
          }),
        )
        // Outside the lock, which the turn's own cleanup takes. Interrupting aborts its query (the CLI exits, its
        // asks are cancelled) or its worktree setup.
        if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value)
        yield* queue.removeWhere((action) => action.sessionId === sessionId)
      }),

      answer: asks.answer,

      busy: (sessionId) => SynchronizedRef.get(turns).pipe(Effect.map((state) => state.live.has(sessionId) || state.parked.has(sessionId))),
    }
  }),
)
