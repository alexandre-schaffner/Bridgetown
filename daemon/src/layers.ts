import { Layer } from "effect"
import { ActionsLive } from "./actions/actions.ts"
import { ActionQueueLive } from "./actions/queue.ts"
import { appSupportDir, type Env } from "./config.ts"
import { HealthLive } from "./health.ts"
import { HubLive } from "./hub.ts"
import { AlertPipelineLive } from "./pipeline/alerts.ts"
import { InboxLive } from "./pipeline/inbox.ts"
import { SchedulerLive } from "./scheduler.ts"
import { Agent, AgentLive } from "./sessions/agent.ts"
import { AsksLive } from "./sessions/asks.ts"
import { SessionRepoLive } from "./sessions/repo.ts"
import { SessionRunnerLive } from "./sessions/runner.ts"
import { GitHub, GitHubLive } from "./ship/github.ts"
import { ShipperLive } from "./ship/shipper.ts"
import { SlackClient, SlackClientLive } from "./slack/client.ts"
import { SlackMeLive } from "./slack/me.ts"
import { SlackThreadLive } from "./slack/thread.ts"
import { Store, StoreLive } from "./store/store.ts"
import { Jev, JevLive } from "./triage/jev.ts"

/**
 * Store, Slack, Jev, agent SDK, GitHub → Hub → the record keepers (sessions, cards, Slack threads,
 * identity, health) → asks → runner → shipper → alert pipeline → inbox, actions → scheduler.
 */
export const appLayer = (env: Env) =>
  appLayerWith(
    env,
    Layer.mergeAll(StoreLive(appSupportDir()), SlackClientLive(env.slackToken), JevLive(env.typesafeKey, env.jevModel), AgentLive, GitHubLive),
  )

/** The app over any Store, Slack client, Jev, agent SDK and GitHub: tests and the mock daemon pass fakes for the outside world. */
export const appLayerWith = <E>(env: Env, base: Layer.Layer<Store | SlackClient | Jev | Agent | GitHub, E>) => {
  const withHub = HubLive(env).pipe(Layer.provideMerge(base))
  const records = Layer.mergeAll(SlackThreadLive, SessionRepoLive, ActionQueueLive, SlackMeLive, HealthLive).pipe(Layer.provideMerge(withHub))
  const withAsks = AsksLive.pipe(Layer.provideMerge(records))
  const withRunner = SessionRunnerLive.pipe(Layer.provideMerge(withAsks))
  const withShipper = ShipperLive.pipe(Layer.provideMerge(withRunner))
  const withPipeline = AlertPipelineLive.pipe(Layer.provideMerge(withShipper))
  const withEdges = Layer.mergeAll(InboxLive, ActionsLive).pipe(Layer.provideMerge(withPipeline))
  return SchedulerLive.pipe(Layer.provideMerge(withEdges))
}
