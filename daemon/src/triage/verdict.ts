import { Effect } from "effect"
import type { Decision, JevVerdict, Triage } from "../domain/alert.ts"
import type { AdapterError, MissingCredential } from "../domain/errors.ts"
import type { Thresholds } from "../domain/settings.ts"
import type { HubShape } from "../hub.ts"

/** The Jev status after a call: ok (and its last problem gone), or why it failed (no key, an error). */
export const reportJev = (hub: HubShape, failure: MissingCredential | AdapterError | null): Effect.Effect<void> =>
  Effect.andThen(
    hub.patchStatus({ jev: failure === null ? "ok" : failure._tag === "MissingCredential" ? "missing_key" : "error" }),
    hub.problem("jev", failure === null ? null : `Jev: ${failure.message}`),
  )

/**
 * Jev's verdict through `decide`, and the Jev status that goes with it. Without Jev (no key, an error) the
 * decision is `fallback` so you make the call, and the status says why.
 */
export const triageWith = (
  hub: HubShape,
  judging: Effect.Effect<JevVerdict, MissingCredential | AdapterError>,
  decide: (jev: JevVerdict, thresholds: Thresholds) => { readonly decision: Decision; readonly reason: string },
  fallback: Decision,
): Effect.Effect<Triage> =>
  Effect.gen(function* () {
    const verdict = yield* Effect.result(judging)
    yield* reportJev(hub, verdict._tag === "Failure" ? verdict.failure : null)
    if (verdict._tag === "Failure") return { decision: fallback, reason: "Jev unavailable — your call", jev: null }
    return { ...decide(verdict.success, (yield* hub.settings).thresholds), jev: verdict.success }
  })
