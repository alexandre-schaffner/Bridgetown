import { Schema } from "effect"
import { LOGS_DATASOURCE } from "../grafana/client.ts"
import type { BrokerRequest } from "./capabilities.ts"
import { MAX_TOOL_BYTES, evidence } from "./policy.ts"

const Endpoint = "http://127.0.0.1:8000/mcp"
const Envelope = Schema.Struct({ id: Schema.optional(Schema.Number), result: Schema.optional(Schema.Unknown), error: Schema.optional(Schema.Unknown) })

/** Fixed MCP endpoint, method and resource. Repository text cannot redirect credentials or tool calls. */
export const observationCall = (args: Extract<BrokerRequest, { tool: "observe" }>["args"], incidentTime: string) => {
  const start = Date.parse(args.start), end = Date.parse(args.end), incident = Date.parse(incidentTime)
  if (!Number.isFinite(incident) || !(end > start) || end - start > 3 * 60 * 60_000 || start < incident - 3 * 60 * 60_000 || end > incident + 3 * 60 * 60_000 || end > Date.now() + 60_000) throw new Error("Observability requests must stay within three hours of the incident and span at most three hours.")
  if (args.operation === "metrics") return { name: "query_prometheus", arguments: { datasourceUid: "P4169E866C3094E38", expr: args.query, startTime: args.start, endTime: args.end, stepSeconds: 60, queryType: "range" } }
  return { name: "grafana_api_request", arguments: { method: "GET", endpoint: `/api/datasources/proxy/uid/${LOGS_DATASOURCE}/select/logsql/query?${new URLSearchParams({ query: args.query, start: String(Math.floor(start / 1000)), end: String(Math.floor(end / 1000)), limit: "100" })}` } }
}

const readBounded = async (response: Response): Promise<string> => {
  if (response.body === null) throw new Error("MCP returned no body.")
  const reader = response.body.getReader()
  let size = 0, body = ""
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return body + decoder.decode()
      size += chunk.value.length
      if (size > MAX_TOOL_BYTES) throw new Error("MCP result exceeded the response limit.")
      body += decoder.decode(chunk.value, { stream: true })
    }
  } finally { await reader.cancel() }
}

/** Each call owns its MCP session, so one investigation cannot borrow another's authority. */
export const observe = async (args: Extract<BrokerRequest, { tool: "observe" }>["args"], incidentTime: string, signal: AbortSignal, fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch): Promise<string> => {
  const call = observationCall(args, incidentTime)
  let session: string | null = null
  const rpc = async (method: string, params: unknown, notification = false): Promise<unknown> => {
    const response = await fetcher(Endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session === null ? {} : { "Mcp-Session-Id": session }) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: 1 }), method, params }),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Grafana MCP refused the read (${response.status}).`) }
    session = response.headers.get("Mcp-Session-Id") ?? session
    if (notification || response.status === 204) { await response.body?.cancel(); return undefined }
    const body = await readBounded(response)
    const messages = response.headers.get("content-type")?.includes("text/event-stream")
      ? body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()) : [body]
    for (const raw of messages) {
      const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(Envelope))(raw)
      if (decoded.id !== 1) continue
      if (decoded.error !== undefined) throw new Error("Grafana MCP could not perform this read.")
      return decoded.result
    }
    throw new Error("MCP response did not answer this request.")
  }
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridgetown-investigation", version: "1" } })
    await rpc("notifications/initialized", {}, true)
    const result = await rpc("tools/call", call)
    if (typeof result === "object" && result !== null && "isError" in result && result.isError === true) throw new Error("Grafana tool could not perform this read.")
    return evidence(`Grafana ${args.operation}`, JSON.stringify(result))
  } finally {
    if (session !== null) await fetcher(Endpoint, { method: "DELETE", redirect: "error", headers: { "Mcp-Session-Id": session }, signal: AbortSignal.timeout(2000) }).then((r) => r.body?.cancel()).catch(() => undefined)
  }
}
