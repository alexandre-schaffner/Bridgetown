import { join } from "node:path"
import { type Context, Layer } from "effect"
import { Agent, type AgentShape } from "../../src/agent/agent.ts"
import { Models, type ModelsShape } from "../../src/agent/models.ts"
import type { Env } from "../../src/config.ts"
import { Reviewer, type ReviewerShape } from "../../src/critique/reviewer.ts"
import { Grafana, type GrafanaShape } from "../../src/grafana/client.ts"
import { Jev, type JevShape } from "../../src/jev.ts"
import { appLayerWith } from "../../src/layers.ts"
import { MemoryModel, type MemoryModelShape } from "../../src/memory/model.ts"
import { GitHub, type GitHubShape } from "../../src/ship/github.ts"
import { SlackClient, type SlackClientShape } from "../../src/slack/client.ts"
import { StoreLive } from "../../src/store/store.ts"
import { fakeGitHub, fakeSlack, noAgent, noGrafana, noJev, noMemoryModel, noReviewer } from "./fakes.ts"
import { fakeModels } from "./models.ts"

/**
 * The daemon's services over a store, the outside world faked. Free of `bun:test`, so the mock daemon and the
 * session smoke script build their worlds from it too; tests take `makeWorld` (world.ts).
 */

/** A fake, or the real adapter's layer for a world that needs it (the mock's live Grafana, the smoke test's agent). */
type Adapter<I, S> = S | Layer.Layer<I>

export interface WorldOptions {
  readonly slack?: Adapter<SlackClient, SlackClientShape>
  readonly jev?: Adapter<Jev, JevShape>
  readonly agent?: Adapter<Agent, AgentShape>
  readonly memoryModel?: Adapter<MemoryModel, MemoryModelShape>
  readonly models?: Adapter<Models, ModelsShape>
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
      adapter(MemoryModel, options.memoryModel, noMemoryModel),
      adapter(Models, options.models, fakeModels()),
      adapter(Reviewer, options.reviewer, noReviewer),
      adapter(GitHub, options.github, fakeGitHub()),
      adapter(Grafana, options.grafana, noGrafana),
    ),
  )
