import { expect, test } from "bun:test"
import { observe } from "../../src/security/observability.ts"

test("broker MCP speaks the fixed LogsQL read protocol, ignores SSE notifications and redacts credentials", async () => {
  const calls: Array<{ url: string; options: RequestInit; body: Record<string, unknown> | null }> = []
  const start = new Date(Date.now() - 600_000).toISOString(), end = new Date().toISOString()
  const result = await observe({ operation: "logs", query: 'message:"error"', start, end }, start, new AbortController().signal, async (url, options) => {
    const body = typeof options.body === "string" ? JSON.parse(options.body) : null
    calls.push({ url, options, body })
    if (body?.method === "initialize") return Response.json({ id: 1, result: {} }, { headers: { "Mcp-Session-Id": "test-session" } })
    if (body?.method === "tools/call") return new Response('data: {"method":"notifications/progress","params":{}}\n\ndata: {"id":1,"result":{"content":[{"type":"text","text":"xoxp-private-token"}]}}\n\n', { headers: { "content-type": "text/event-stream" } })
    return new Response(null, { status: 204 })
  })
  expect(result).not.toContain("xoxp-private-token")
  expect(result).toContain("credential redacted")
  expect(calls.every((call) => call.url === "http://127.0.0.1:8000/mcp" && call.options.redirect === "error")).toBe(true)
  expect(calls[2]?.body?.params).toMatchObject({ name: "grafana_api_request", arguments: { method: "GET" } })
  const params = calls[2]?.body?.params
  if (typeof params !== "object" || params === null || !("arguments" in params)) throw new Error("missing call")
  expect(JSON.stringify(params.arguments)).toContain("/select/logsql/query?")
  expect(JSON.stringify(params.arguments)).toContain("limit=100")
  expect(calls.at(-1)?.options.method).toBe("DELETE")
})
