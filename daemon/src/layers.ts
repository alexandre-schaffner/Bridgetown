import { Layer } from "effect"
import { ActionsLive } from "./actions/actions.ts"
import { ActionQueueLive } from "./actions/queue.ts"
import { appSupportDir, type Env } from "./config.ts"
import { CriticLive } from "./critique/critic.ts"
import { Reviewer, ReviewerLive } from "./critique/reviewer.ts"
import { BoardsLive } from "./grafana/board.ts"
import { Grafana, GrafanaLive } from "./grafana/client.ts"
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
import { ClaimsLive } from "./slack/claims.ts"
import { SlackClient, SlackClientLive } from "./slack/client.ts"
import { SlackMeLive } from "./slack/me.ts"
import { SlackThreadLive } from "./slack/thread.ts"
import { Store, StoreLive } from "./store/store.ts"
import { Jev, JevLive } from "./triage/jev.ts"
import { WatcherLive } from "./watch/watcher.ts"

/**
 * Store, Slack, Jev, agent SDK, reviewer, GitHub, Grafana → Hub → the record keepers (sessions, cards, Slack threads,
 * identity, health, Grafana boards) → asks, claims → runner → shipper, critic → alert pipeline → inbox, actions, prod watcher → scheduler.
 */
export const appLayer = (env: Env) =>
  appLayerWith(
    env,
    Layer.mergeAll(StoreLive(appSupportDir()), SlackClientLive(env.slackToken), JevLive(env.typesafeKey, env.jevModel), AgentLive, ReviewerLive, GitHubLive, GrafanaLive),
  )

/** The app over any Store, Slack client, Jev, agent SDK, reviewer, GitHub and Grafana: tests and the mock daemon pass fakes for the outside world. */
export const appLayerWith = <E>(env: Env, base: Layer.Layer<Store | SlackClient | Jev | Agent | Reviewer | GitHub | Grafana, E>) => {
  const withHub = HubLive(env).pipe(Layer.provideMerge(base))
  const records = Layer.mergeAll(SlackThreadLive, SessionRepoLive, ActionQueueLive, SlackMeLive, HealthLive, BoardsLive).pipe(Layer.provideMerge(withHub))
  const withAsks = Layer.mergeAll(AsksLive, ClaimsLive).pipe(Layer.provideMerge(records))
  const withRunner = SessionRunnerLive.pipe(Layer.provideMerge(withAsks))
  const withShipper = Layer.mergeAll(ShipperLive, CriticLive).pipe(Layer.provideMerge(withRunner))
  const withPipeline = AlertPipelineLive.pipe(Layer.provideMerge(withShipper))
  const withEdges = Layer.mergeAll(InboxLive, ActionsLive, WatcherLive).pipe(Layer.provideMerge(withPipeline))
  return SchedulerLive.pipe(Layer.provideMerge(withEdges))
}
