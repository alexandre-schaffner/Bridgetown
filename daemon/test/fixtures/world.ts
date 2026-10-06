import { Effect, Layer, ManagedRuntime } from "effect"
import type { Env } from "../../src/config.ts"
import type { JevVerdict } from "../../src/domain/alert.ts"
import { MissingCredential } from "../../src/domain/errors.ts"
import { Grafana, type GrafanaShape } from "../../src/grafana/client.ts"
import { appLayerWith } from "../../src/layers.ts"
import { Reviewer, ReviewerLive, type ReviewerShape } from "../../src/critique/reviewer.ts"
import { Agent, AgentLive, type AgentShape } from "../../src/sessions/agent.ts"
import { GitHub, GitHubLive, type GitHubShape } from "../../src/ship/github.ts"
import { SlackClient, type SlackClientShape, type SlackMessage } from "../../src/slack/client.ts"
import { StoreLive } from "../../src/store/store.ts"
import { Jev, type JevShape } from "../../src/triage/jev.ts"
import { scratchDir } from "./tmp.ts"

export const verdict = (overrides: Partial<JevVerdict> = {}): JevVerdict => ({
  actionable: 0.95, agentResolvable: 0.9, humanOnIt: 0.01, kind: "build_failure", kindConfidence: 0.9, depth: "quick", urgency: 1, ...overrides,
})

/** Slack as the tests want it: `latest` serves `messages(channel)`, posts succeed, everything else is empty. */
export const fakeSlack = (messages: (channel: string) => ReadonlyArray<SlackMessage>): SlackClientShape => ({
  identity: () => Effect.succeed({ user_id: "UME", user: "me", url: "https://merkl.slack.com/" }),
  latest: (channel) => Effect.sync(() => messages(channel)),
  replies: () => Effect.succeed([]),
  permalink: (channel, ts) => Effect.succeed(`https://merkl.slack.com/archives/${channel}/p${ts.replace(".", "")}`),
  search: () => Effect.succeed([]),
  groupsOf: () => Effect.succeed([]),
  userName: (id) => Effect.succeed(id),
  post: () => Effect.succeed("1.000001"),
  remove: () => Effect.void,
})

const noJev: JevShape = {
  judge: () => Effect.fail(new MissingCredential({ service: "jev", message: "no TypeSafe API key" })),
  judgeInbox: () => Effect.fail(new MissingCredential({ service: "jev", message: "no TypeSafe API key" })),
  judgeFinding: () => Effect.fail(new MissingCredential({ service: "jev", message: "no TypeSafe API key" })),
  judgeLogPatterns: () => Effect.fail(new MissingCredential({ service: "jev", message: "no TypeSafe API key" })),
}

/** Grafana with no data: every query answers with no series and no rows. */
export const noGrafana: GrafanaShape = {
  prom: () => Effect.succeed([]),
  logStats: () => Effect.succeed([]),
  logRows: () => Effect.succeed([]),
}

export interface WorldOptions {
  readonly slack?: SlackClientShape
  readonly jev?: JevShape
  readonly dryRun?: boolean
  readonly agent?: AgentShape
  readonly reviewer?: ReviewerShape
  readonly github?: GitHubShape
  readonly grafana?: GrafanaShape
  /** An existing `BRIDGETOWN_HOME` (a store an older daemon wrote); a fresh scratch dir otherwise. */
  readonly home?: string
}

/** The real services over a temp store, with Slack and Jev faked (and the SDK and GitHub when a test passes them). Nothing reaches the network or the SDK unless a test starts a turn. */
export const makeWorld = (options: WorldOptions = {}) => {
  const home = options.home ?? scratchDir("bt-world-")
  process.env.BRIDGETOWN_HOME = home
  const env: Env = { port: 0, apiToken: "t", slackToken: "xoxp-test", typesafeKey: "k", forceDryRun: options.dryRun ?? true, jevModel: "jev" }
  const base = Layer.mergeAll(
    StoreLive(home),
    Layer.succeed(SlackClient)(options.slack ?? fakeSlack(() => [])),
    Layer.succeed(Jev)(options.jev ?? noJev),
    options.agent === undefined ? AgentLive : Layer.succeed(Agent)(options.agent),
    options.reviewer === undefined ? ReviewerLive : Layer.succeed(Reviewer)(options.reviewer),
    options.github === undefined ? GitHubLive : Layer.succeed(GitHub)(options.github),
    Layer.succeed(Grafana)(options.grafana ?? noGrafana),
  )
  return ManagedRuntime.make(appLayerWith(env, base))
}
