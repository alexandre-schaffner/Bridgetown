import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { abortOnReturn } from "../../src/agent/agent.ts"

test("stream finalization after natural completion keeps the job controller live", async () => {
  const abort = new AbortController()
  const messages = async function* () { yield "proposal" }
  expect(await Effect.runPromise(Stream.fromAsyncIterable(abortOnReturn(messages(), abort), String).pipe(Stream.runCollect))).toEqual(["proposal"])
  expect(abort.signal.aborted).toBe(false)
})

test("abandoning a pending iterator aborts before awaiting its return", async () => {
  const abort = new AbortController()
  let released = false
  const messages = async function* () {
    try { await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true })) }
    finally { released = true }
  }
  const iterator = abortOnReturn(messages(), abort)[Symbol.asyncIterator]()
  const pending = iterator.next()
  await iterator.return?.()
  expect((await pending).done).toBe(true)
  expect(abort.signal.aborted).toBe(true)
  expect(released).toBe(true)
})
