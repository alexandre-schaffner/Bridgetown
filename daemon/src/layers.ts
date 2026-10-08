import { Layer } from "effect"
import { ActionsLive } from "./actions/actions.ts"
import { ActionQueueLive } from "./actions/queue.ts"
import { Models, ModelsLive } from "./agent/models.ts"
import { Agent, AgentLive } from "./agent/agent.ts"
import { type Env, Environment } from "./config.ts"
import { CriticLive } from "./critique/critic.ts"
import { Reviewer, ReviewerLive } from "./critique/reviewer.ts"
import { BoardsLive } from "./grafana/board.ts"
import { Grafana, GrafanaLive } from "./grafana/client.ts"
import { HealthLive } from "./health.ts"
import { HousekeepingLive } from "./housekeeping/housekeeping.ts"
import { HubLive } from "./hub.ts"
import { AlertChannelsLive } from "./intake/alerts.ts"
import { InboxLive } from "./intake/inbox.ts"
import { IntakeLive } from "./intake/intake.ts"
import { MemoryLive } from "./memory/memory.ts"
import { MemoryModel, MemoryModelLive } from "./memory/model.ts"
import { Jev, JevLive } from "./jev.ts"
import { SchedulerLive } from "./scheduler.ts"
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
import { WatcherLive } from "./watch/watcher.ts"

/**
 * The environment, store, Slack, Jev, agent SDK, reviewer, GitHub, Grafana → Hub → Slack identity → the record keepers (sessions,
 * cards, Slack threads, health, Grafana boards, worktrees) → asks, claims → runner → shipper, critic, housekeeping, intake → what
 * feeds intake (alert channels, inbox, prod watcher) and the cards' buttons → scheduler.
 */
export const appLayer = (env: Env) =>
  appLayerWith(
    env,
    Layer.mergeAll(
      StoreLive(env.home, [env.apiToken, env.slackToken, env.typesafeKey, process.env.ANTHROPIC_API_KEY]),
      SlackClientLive(env.slackToken),
      JevLive(env.typesafeKey, env.jevModel),
      AgentLive(env.claudePath, env.codexPath),
      MemoryModelLive(env.claudePath),
      ModelsLive(env),
      ReviewerLive(env.codexPath, env.claudePath),
      GitHubLive,
      GrafanaLive,
    ),
  )

/** The app over any Store, Slack client, Jev, agent SDK, reviewer, GitHub and Grafana: tests and the mock daemon pass fakes for the outside world. */
export const appLayerWith = <E>(env: Env, base: Layer.Layer<Store | SlackClient | Jev | Agent | MemoryModel | Models | Reviewer | GitHub | Grafana, E>) => {
  const withHub = HubLive.pipe(Layer.provideMerge(Layer.mergeAll(base, Layer.succeed(Environment)(env))))
  const withMemory = MemoryLive.pipe(Layer.provideMerge(withHub))
  const withMe = SlackMeLive.pipe(Layer.provideMerge(withMemory))
  const records = Layer.mergeAll(SlackThreadLive, SessionRepoLive, ActionQueueLive, HealthLive, BoardsLive, WorktreesLive).pipe(Layer.provideMerge(withMe))
  const withAsks = Layer.mergeAll(AsksLive, ClaimsLive).pipe(Layer.provideMerge(records))
  const withRunner = SessionRunnerLive.pipe(Layer.provideMerge(withAsks))
  const withIntake = Layer.mergeAll(ShipperLive, CriticLive, HousekeepingLive, IntakeLive).pipe(Layer.provideMerge(withRunner))
  const withEdges = Layer.mergeAll(AlertChannelsLive, InboxLive, WatcherLive, ActionsLive).pipe(Layer.provideMerge(withIntake))
  return SchedulerLive.pipe(Layer.provideMerge(withEdges))
}
