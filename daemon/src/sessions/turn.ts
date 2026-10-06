import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { type Cause, Effect, Exit, FiberSet, Queue, Stream } from "effect"
import { abortOnReturn, type AgentShape } from "../agent/agent.ts"
import { type EventSink, handleMessage, type TurnEnd } from "../agent/events.ts"
import { sdkOptions } from "../agent/options.ts"
import type { ToolCallbacks } from "../agent/tools.ts"
import { AdapterError, errorMessage } from "../domain/errors.ts"
import type { Session } from "../domain/session.ts"
import type { HubShape } from "../hub.ts"
import { truncate } from "../lib/text.ts"
import type { SlackThreadShape } from "../slack/thread.ts"
import type { StoreShape } from "../store/store.ts"
import type { AsksShape } from "./asks.ts"
import { slackContextText } from "./prompts.ts"
import type { SessionRepoShape } from "./repo.ts"

/**
 * A turn's streaming input. The first prompt goes in when the turn is claimed;
 * your messages go in while it runs (the agent reads them at its next step); the
 * turn's result ends it so the CLI exits. Once ended, `offer` returns false.
 */
export type TurnInput = Queue.Queue<SDKUserMessage, Cause.Done>

/** `next`: the CLI hands it to the agent at its next step instead of after the turn. */
export const userMessage = (text: string, priority?: "next"): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  ...(priority === undefined ? {} : { priority }),
})

export const makeTurnInput = (prompt: string) =>
  Effect.gen(function* () {
    const input: TurnInput = yield* Queue.unbounded<SDKUserMessage, Cause.Done>()
    yield* Queue.offer(input, userMessage(prompt))
    return input
  })

export interface TurnDeps {
  readonly store: StoreShape
  readonly hub: HubShape
  readonly thread: SlackThreadShape
  readonly repo: SessionRepoShape
  readonly asks: AsksShape
  readonly agent: AgentShape
  readonly onEnd: (id: string) => (end: TurnEnd) => Effect.Effect<void, AdapterError>
  readonly onFailure: (id: string, reason: string) => Effect.Effect<void>
  /** The daemon's API port, which sessions may not reach. */
  readonly daemonPort: number
  /** The daemon's home, where the exec-time guard's shims live. */
  readonly home: string
}

export const makeTurns = (deps: TurnDeps) => {
  const { store, thread, repo, asks } = deps

  /** The SDK's tool callbacks, each run on a fiber of the turn (`runPromise`), so none outlives it. */
  const toolsFor = (session: Session, runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>): ToolCallbacks => ({
    slackContext: (minutes) =>
      runPromise(
        Effect.gen(function* () {
          const alert = yield* store.getAlert(session.alertId)
          if (alert === undefined) return "The alert is no longer stored."
          return slackContextText(alert, yield* thread.replies(alert), yield* thread.nearby(alert, minutes), minutes)
        }).pipe(Effect.orElseSucceed(() => "Slack context is unavailable right now.")),
      ),
    report: (phase, note, prUrl) =>
      runPromise(
        repo
          .patch(session.id, { phase, activity: note })
          .pipe(Effect.andThen(repo.log(session.id, "status", `${phase}: ${note}${prUrl === null ? "" : ` ${prUrl}`}`)), Effect.ignore),
      ),
    ask: (question, options) => runPromise(asks.ask(session, question, options)),
  })

  /**
   * One SDK query, consumed as a stream until the CLI exits. Interrupting it (a
   * stop, shutdown) aborts the query and kills the CLI. Otherwise it never ends
   * without an outcome: its result is applied, or the session fails (the CLI
   * failed or exited without a result, the result could not be applied, a
   * defect). Nothing its tools started outlives it: an open `ask` ends with it.
   */
  const runTurn = (id: string, session: Session, input: TurnInput, resume: boolean): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* repo.log(id, "status", resume ? "Resumed with a follow-up" : "Session started")
        const runPromise = yield* FiberSet.makeRuntimePromise()
        const abort = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller, exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => controller.abort())),
        )
        const onRefused = (what: string, reason: string) => {
          // Rejected once the turn is over; nobody awaits it, and an unhandled rejection would end the daemon.
          runPromise(repo.log(id, "error", `Refused: ${truncate(what, 120)} — ${reason}`).pipe(Effect.ignore)).catch(() => undefined)
        }
        const end = { seen: false }
        const sink: EventSink = {
          repo,
          hub: deps.hub,
          closeInput: () => void Queue.endUnsafe(input),
          onEnd: (turnEnd) => {
            end.seen = true
            return deps.onEnd(id)(turnEnd)
          },
        }
        const messages = deps.agent.query({
          prompt: Stream.toAsyncIterable(Stream.fromQueue(input)),
          options: sdkOptions({ session, abort, resume, tools: toolsFor(session, runPromise), onRefused, daemonPort: deps.daemonPort, home: deps.home }),
        })
        yield* Stream.fromAsyncIterable(
          abortOnReturn(messages, abort),
          (cause) => new AdapterError({ adapter: "claude", operation: "query", message: errorMessage(cause), cause }),
        ).pipe(
          Stream.runForEach((message) => {
            const handled = handleMessage(id, message, sink)
            if (message.type === "result") return handled
            // A message Bridgetown could not take in (an odd shape from the user's own CLI) costs a transcript line, not the turn.
            const skipped = (reason: string) => repo.log(id, "error", `Skipped an SDK ${message.type} message: ${reason}`).pipe(Effect.ignore)
            return handled.pipe(
              Effect.catch((error) => skipped(error.message)),
              Effect.catchDefect((defect) => skipped(errorMessage(defect))),
            )
          }),
        )
        if (!end.seen) yield* deps.onFailure(id, "The agent exited without a result")
      }),
    ).pipe(
      Effect.catch((error) => deps.onFailure(id, error.message)),
      Effect.catchDefect((defect) => deps.onFailure(id, errorMessage(defect))),
      Effect.ensuring(Queue.end(input)),
    )

  return { runTurn }
}
