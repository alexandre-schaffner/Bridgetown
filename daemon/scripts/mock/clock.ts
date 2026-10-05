/**
 * `MOCK_NOW` (an ISO instant) stops the wall clock there: `Date.now()` and
 * `new Date()` return it for the whole run, so alert and card ids, ages, charts
 * and every timestamp the daemon writes come out the same each run. main.ts
 * imports this first, before any module reads the time. Timers still run:
 * sleeps use setTimeout and Effect measures durations on the monotonic clock.
 * What counts elapsed wall time (the live mock's release tracker, PRs that move
 * on their own) stands still with it, which only a static world wants.
 */
const frozen = process.env.MOCK_NOW
if (frozen !== undefined && frozen !== "") {
  const at = Date.parse(frozen)
  if (Number.isNaN(at)) throw new Error(`MOCK_NOW is not a date: ${frozen}`)
  globalThis.Date = new Proxy(Date, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [at] : args, newTarget),
    apply: (target) => new target(at).toString(),
    get: (target, key, receiver) => (key === "now" ? () => at : Reflect.get(target, key, receiver)),
  })
}

export {}
