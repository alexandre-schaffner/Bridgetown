import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeGrafana } from "../src/grafana/client.ts"

/** A minimal MCP server: `initialize` hands out a session, `tools/call` answers with what `answer` says for it. */
const mcpServer = (answer: (session: string | null, call: number) => Response | unknown) => {
  const counts = { initialize: 0, call: 0 }
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as { readonly id?: number; readonly method: string }
      if (body.method === "initialize") {
        counts.initialize++
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} }, { headers: { "Mcp-Session-Id": `s${counts.initialize}` } })
      }
      if (body.method !== "tools/call") return new Response(null, { status: 202 })
      counts.call++
      const result = answer(request.headers.get("Mcp-Session-Id"), counts.call)
      return result instanceof Response ? result : Response.json({ jsonrpc: "2.0", id: body.id, result })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/mcp`, counts, stop: () => server.stop(true) }
}

const range = { start: new Date(Date.now() - 60 * 60_000), end: new Date(), stepSeconds: 60 }
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] })

describe("the Grafana MCP client", () => {
  const servers: Array<{ readonly stop: () => void }> = []
  afterAll(() => servers.forEach((s) => s.stop()))

  test("a session the server lost (it restarted) is opened again and the call retried once", async () => {
    // The first session is forgotten after its first call.
    const server = mcpServer((session) => (session === "s1" ? new Response("unknown session", { status: 404 }) : text({ data: [] })))
    servers.push(server)
    const series = await Effect.runPromise(Effect.flatMap(makeGrafana(server.url), (grafana) => grafana.prom("up", range)))
    expect(series).toEqual([])
    expect(server.counts).toEqual({ initialize: 2, call: 2 })
  })

  test("a tool's own error fails at once: a heavy query is never run twice", async () => {
    const server = mcpServer(() => ({ isError: true, content: [{ type: "text", text: "VictoriaLogs answered 503" }] }))
    servers.push(server)
    const failure = await Effect.runPromise(Effect.flatMap(makeGrafana(server.url), (grafana) => grafana.logRows("error", range, 10)).pipe(Effect.flip))
    expect(failure.message).toBe("VictoriaLogs answered 503")
    expect(server.counts).toEqual({ initialize: 1, call: 1 })
  })
})
