import { Context, Effect, Layer } from "effect"
import { errorMessage } from "./domain/errors.ts"
import { Grafana } from "./grafana/client.ts"
import { Hub } from "./hub.ts"
import { bunMismatchOf } from "./sessions/worktree.ts"
import { GitHub } from "./ship/github.ts"

/** Readiness of what sessions depend on, reported in `Status`. */
export interface HealthShape {
  /** The local grafana MCP server sessions read logs through. */
  readonly probeGrafana: Effect.Effect<void>
  /** Sessions cannot fetch, push or read CI without GHE, so they wait in the queue while it is unreachable. */
  readonly probeGithub: Effect.Effect<void>
  /** Rechecks Bun after upgrades, so a worktree's setup warning does not stay stale. */
  readonly probeBun: Effect.Effect<void>
}

export class Health extends Context.Service<Health, HealthShape>()("Health") {}

export const HealthLive = Layer.effect(Health)(
  Effect.gen(function* () {
    const hub = yield* Hub
    const gh = yield* GitHub
    const grafana = yield* Grafana
    return {
      probeGrafana: grafana.reachable.pipe(Effect.flatMap((up) => hub.patchStatus({ grafanaMcp: up ? "up" : "down" }))),
      // `Status.github` is the whole story (the app says what it means); it is not repeated in `Status.error`.
      probeGithub: gh.reachability.pipe(Effect.flatMap((github) => hub.patchStatus({ github }))),
      probeBun: hub.settings.pipe(
        Effect.flatMap((settings) => Effect.forEach([...new Set([settings.monorepoPath, settings.deploymentRepoPath].filter((path) => path !== ""))], bunMismatchOf)),
        Effect.flatMap((warnings) => hub.problem("setup", warnings.find((warning) => warning !== null) ?? null)),
        Effect.catch((error) => hub.problemFor("setup").pipe(Effect.flatMap((standing) =>
          standing === null ? hub.problem("setup", `Bun readiness check failed: ${errorMessage(error)}`) : Effect.void,
        ))),
      ),
    }
  }),
)
