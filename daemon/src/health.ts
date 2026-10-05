import { Context, Effect, Layer } from "effect"
import { GRAFANA_MCP_URL } from "./grafana/client.ts"
import { Hub } from "./hub.ts"
import { GitHub } from "./ship/github.ts"

/** Reachability of what sessions depend on, reported in `Status`. */
export interface HealthShape {
  /** The local grafana MCP server sessions read logs through. */
  readonly probeGrafana: Effect.Effect<void>
  /** Sessions cannot fetch, push or read CI without GHE, so they wait in the queue while it is unreachable. */
  readonly probeGithub: Effect.Effect<void>
}

export class Health extends Context.Service<Health, HealthShape>()("Health") {}

export const HealthLive = Layer.effect(Health)(
  Effect.gen(function* () {
    const hub = yield* Hub
    const gh = yield* GitHub
    return {
      probeGrafana: Effect.tryPromise(() => fetch(GRAFANA_MCP_URL, { method: "GET", signal: AbortSignal.timeout(2_000) })).pipe(
        Effect.match({ onFailure: () => "down" as const, onSuccess: () => "up" as const }),
        Effect.flatMap((state) => hub.patchStatus({ grafanaMcp: state })),
      ),
      // `Status.github` is the whole story (the app says what it means); it is not repeated in `Status.error`.
      probeGithub: gh.reachability.pipe(Effect.flatMap((github) => hub.patchStatus({ github }))),
    }
  }),
)
