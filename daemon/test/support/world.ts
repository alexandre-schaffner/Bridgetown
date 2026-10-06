import { join } from "node:path"
import { type Context, Layer, ManagedRuntime } from "effect"
import type { Env } from "../../src/config.ts"
import { Reviewer, type ReviewerShape } from "../../src/critique/reviewer.ts"
import { Grafana, type GrafanaShape } from "../../src/grafana/client.ts"
import { appLayerWith } from "../../src/layers.ts"
import { Agent, type AgentShape } from "../../src/sessions/agent.ts"
import { GitHub, type GitHubShape } from "../../src/ship/github.ts"
import { SlackClient, type SlackClientShape } from "../../src/slack/client.ts"
import { StoreLive } from "../../src/store/store.ts"
import { Jev, type JevShape } from "../../src/triage/jev.ts"
import { fakeGitHub, fakeSlack, noAgent, noGrafana, noJev, noReviewer } from "./fakes.ts"
import { scratchDir } from "./tmp.ts"

/** A fake, or the real adapter's layer for a world that needs it (the mock's live Grafana, the smoke test's agent). */
type Adapter<I, S> = S | Layer.Layer<I>

export interface WorldOptions {
  readonly slack?: Adapter<SlackClient, SlackClientShape>
  readonly jev?: Adapter<Jev, JevShape>
  readonly agent?: Adapter<Agent, AgentShape>
  readonly reviewer?: Adapter<Reviewer, ReviewerShape>
  readonly github?: Adapter<GitHub, GitHubShape>
  readonly grafana?: Adapter<Grafana, GrafanaShape>
  /** Over `testEnv`'s. */
  readonly env?: Partial<Env>
}

/** A launch environment for tests: everything under `home`, dry run, and the default CLIs. */
export const testEnv = (home: string, overrides: Partial<Env> = {}): Env => ({
  port: 0,
  home,
  apiToken: "t",
  slackToken: "xoxp-test",
  typesafeKey: "k",
  forceDryRun: true,
  jevModel: "jev",
  claudePath: undefined,
  claudeConfigDir: join(home, "claude"),
  codexPath: undefined,
  ...overrides,
})

const adapter = <I, S>(tag: Context.Service<I, S>, given: Adapter<I, S> | undefined, fake: S): Layer.Layer<I> => {
  if (given === undefined) return Layer.succeed(tag)(fake)
  return Layer.isLayer(given) ? (given as Layer.Layer<I>) : Layer.succeed(tag)(given as S)
}

/**
 * The real services over a store under `home`, with the outside world faked: Slack that has nothing, Jev without a
 * key, GitHub with no PR, Grafana with no data, and no agent or reviewer to run. Options swap in what a caller is about.
 */
export const worldLayer = (home: string, options: WorldOptions = {}) =>
  appLayerWith(
    testEnv(home, options.env),
    Layer.mergeAll(
      StoreLive(home),
      adapter(SlackClient, options.slack, fakeSlack()),
      adapter(Jev, options.jev, noJev),
      adapter(Agent, options.agent, noAgent),
      adapter(Reviewer, options.reviewer, noReviewer),
      adapter(GitHub, options.github, fakeGitHub()),
      adapter(Grafana, options.grafana, noGrafana),
    ),
  )

/** `worldLayer` as a runtime, over a scratch store unless `home` is an existing one (a store an older daemon wrote). */
export const makeWorld = (options: WorldOptions & { readonly home?: string } = {}) =>
  ManagedRuntime.make(worldLayer(options.home ?? scratchDir("bt-world-"), options))
