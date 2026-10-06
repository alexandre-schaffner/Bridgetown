import { afterAll, describe, expect, setSystemTime, test } from "bun:test"
import { Effect } from "effect"
import { Boards } from "../src/grafana/board.ts"
import { overviewBoard } from "../src/grafana/boards.ts"
import { watchBoard } from "../src/watch/detect.ts"
import type { GrafanaShape } from "../src/grafana/client.ts"
import { Hub } from "../src/hub.ts"
import { noGrafana } from "./support/fakes.ts"
import { makeWorld } from "./support/world.ts"

let calls = 0
const slowGrafana: GrafanaShape = {
  ...noGrafana,
  prom: () => Effect.sync(() => calls++).pipe(Effect.andThen(Effect.sleep("50 millis")), Effect.as([])),
  logStats: () => Effect.sync(() => calls++).pipe(Effect.andThen(Effect.sleep("50 millis")), Effect.as([])),
}
const world = makeWorld({ grafana: slowGrafana })
afterAll(() => world.dispose())

describe("board cache", () => {
  test("concurrent opens of one board share a single fetch", async () => {
    const boards = await world.runPromise(
      Effect.gen(function* () {
        yield* (yield* Hub).patchStatus({ grafanaMcp: "up" })
        const b = yield* Boards
        const spec = overviewBoard("infra", new Date())
        return yield* Effect.all([b.build(spec), b.build(spec), b.build(spec)], { concurrency: "unbounded" })
      }),
    )
    expect(boards.map((b) => b.error)).toEqual([null, null, null])
    expect(calls).toBe(4) // the infra board's four panels, once
  })

  test("a request that goes away doesn't lose the fetch: the next one is a cache hit", async () => {
    calls = 0
    await world.runPromise(
      Effect.gen(function* () {
        const b = yield* Boards
        const spec = overviewBoard("incidents", new Date())
        // Abandoned after 10ms, long before the 50ms queries answer.
        yield* b.build(spec).pipe(Effect.timeoutOption("10 millis"))
        yield* Effect.sleep("100 millis")
        const before = calls
        yield* b.build(spec)
        expect(calls).toBe(before)
      }),
    )
    expect(calls).toBe(4)
  })

  test("a board nobody opened for ten minutes is dropped once another one is cached", async () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 12, minutes))
    try {
      const fetched = await world.runPromise(
        Effect.gen(function* () {
          const b = yield* Boards
          setSystemTime(at(0))
          const first = yield* b.build(overviewBoard("database", at(0)))
          setSystemTime(at(11))
          yield* b.build(watchBoard(at(11)))
          // Evicted, so this waits for a fresh fetch instead of answering with the old board.
          return [first.fetchedAt, (yield* b.build(overviewBoard("database", at(11)))).fetchedAt]
        }),
      )
      expect(fetched).toEqual([at(0).toISOString(), at(11).toISOString()])
    } finally {
      setSystemTime()
    }
  })
})
