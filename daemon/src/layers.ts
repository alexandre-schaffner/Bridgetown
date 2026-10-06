import { Layer } from "effect"
import { ActionsLive } from "./actions/actions.ts"
import { ActionQueueLive } from "./actions/queue.ts"
import { appSupportDir, type Env } from "./config.ts"
import { CriticLive } from "./critique/critic.ts"
import { Reviewer, ReviewerLive } from "./critique/reviewer.ts"
import { BoardsLive } from "./grafana/board.ts"
import { Grafana, GrafanaLive } from "./grafana/client.ts"
import { HealthLive } from "./health.ts"
import { HousekeepingLive } from "./housekeeping/housekeeping.ts"
import { HubLive } from "./hub.ts"
import { AlertPipelineLive } from "./pipeline/alerts.ts"
import { InboxLive } from "./pipeline/inbox.ts"
import { IntakeLive } from "./pipeline/intake.ts"
import { SchedulerLive } from "./scheduler.ts"
import { Agent, AgentLive } from "./sessions/agent.ts"
import { AsksLive } from "./sessions/asks.ts"
import { SessionRepoLive } from "./sessions/repo.ts"
import { SessionRunnerLive } from "./sessions/runner.ts"
import { WorktreesLive } from "./sessions/worktree.ts"
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
 * Store, Slack, Jev, agent SDK, reviewer, GitHub, Grafana → Hub → Slack identity → the record keepers (sessions,
 * cards, Slack threads, health, Grafana boards, worktrees) → asks, claims → runner → shipper, critic, housekeeping, intake → what
 * feeds intake (alert channels, inbox, prod watcher) and the cards' buttons → scheduler.
 */
export const appLayer = (env: Env) =>
  appLayerWith(
    env,
    Layer.mergeAll(StoreLive(appSupportDir()), SlackClientLive(env.slackToken), JevLive(env.typesafeKey, env.jevModel), AgentLive, ReviewerLive, GitHubLive, GrafanaLive),
  )

/** The app over any Store, Slack client, Jev, agent SDK, reviewer, GitHub and Grafana: tests and the mock daemon pass fakes for the outside world. */
export const appLayerWith = <E>(env: Env, base: Layer.Layer<Store | SlackClient | Jev | Agent | Reviewer | GitHub | Grafana, E>) => {
  const withHub = HubLive(env).pipe(Layer.provideMerge(base))
  const withMe = SlackMeLive.pipe(Layer.provideMerge(withHub))
  const records = Layer.mergeAll(SlackThreadLive, SessionRepoLive, ActionQueueLive, HealthLive, BoardsLive, WorktreesLive).pipe(Layer.provideMerge(withMe))
  const withAsks = Layer.mergeAll(AsksLive, ClaimsLive).pipe(Layer.provideMerge(records))
  const withRunner = SessionRunnerLive.pipe(Layer.provideMerge(withAsks))
  const withIntake = Layer.mergeAll(ShipperLive, CriticLive, HousekeepingLive, IntakeLive).pipe(Layer.provideMerge(withRunner))
  const withEdges = Layer.mergeAll(AlertPipelineLive, InboxLive, WatcherLive, ActionsLive).pipe(Layer.provideMerge(withIntake))
  return SchedulerLive.pipe(Layer.provideMerge(withEdges))
}
