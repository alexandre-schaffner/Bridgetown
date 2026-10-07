import { ManagedRuntime } from "effect"
import { type WorldOptions, worldLayer } from "./world-layer.ts"
import { scratchDir } from "./tmp.ts"

export { testEnv, type WorldOptions, worldLayer } from "./world-layer.ts"

/** `worldLayer` as a runtime, over a scratch store unless `home` is an existing one (a store to reopen). */
export const makeWorld = (options: WorldOptions & { readonly home?: string } = {}) =>
  ManagedRuntime.make(worldLayer(options.home ?? scratchDir("bt-world-"), options))
