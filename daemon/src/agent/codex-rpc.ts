import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { Schema } from "effect"
import { VERSION } from "../config.ts"
import { childEnv } from "../secrets.ts"

const Id = Schema.Union([Schema.String, Schema.Number])
const Envelope = Schema.Struct({
  id: Schema.optional(Id), method: Schema.optional(Schema.String), params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown), error: Schema.optional(Schema.Struct({ message: Schema.String })),
})
export type RpcMessage = typeof Envelope.Type

/** Bounded JSON-RPC over one local child. Closing rejects every outstanding operation. */
export class CodexRpc {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly messages: Array<RpcMessage> = []
  private wake: (() => void) | undefined
  private failure: Error | undefined
  private sequence = 0
  private stderr = ""
  private readonly onAbort: () => void

  constructor(command: ReadonlyArray<string>, readonly signal: AbortSignal, env: Record<string, string> = {}, cwd?: string) {
    const [executable, ...args] = command
    if (executable === undefined) throw new Error("No Codex executable")
    this.child = spawn(executable, args, { cwd, env: { ...childEnv(process.env), ...env }, stdio: ["pipe", "pipe", "pipe"] })
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-2000) })
    this.child.on("error", (error) => this.close(error))
    this.child.on("exit", (code) => this.close(new Error(`Codex app-server exited ${code ?? "unexpectedly"}: ${this.stderr.trim().slice(-400)}`)))
    this.child.stdin.on("error", (error) => this.close(error))
    const lines = createInterface({ input: this.child.stdout })
    lines.on("line", (line) => {
      try {
        const message = Schema.decodeUnknownSync(Schema.fromJsonString(Envelope))(line)
        if (message.method === undefined && typeof message.id === "number") {
          const pending = this.pending.get(message.id)
          if (pending === undefined) return
          this.pending.delete(message.id)
          if (message.error !== undefined) pending.reject(new Error(message.error.message))
          else pending.resolve(message.result)
        } else {
          if (this.messages.length >= 1000) throw new Error("Codex sent too many pending events")
          this.messages.push(message)
          this.wake?.()
        }
      } catch (cause) { this.close(cause instanceof Error ? cause : new Error(String(cause))) }
    })
    this.onAbort = () => this.close(new Error("Codex interrupted"))
    signal.addEventListener("abort", this.onAbort, { once: true })
    if (signal.aborted) this.onAbort()
  }

  private write(value: unknown): void {
    if (this.failure !== undefined) throw this.failure
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  async request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    const id = ++this.sequence
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)) }, timeoutMs)
        try { this.write({ id, method, params }) } catch (cause) { this.pending.delete(id); reject(cause) }
      })
    } finally { clearTimeout(timer) }
  }

  reply(id: string | number, result: unknown): void { this.write({ id, result }) }
  reject(id: string | number, message: string): void { this.write({ id, error: { code: -32601, message } }) }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "bridgetown", title: "Bridgetown", version: VERSION }, capabilities: { experimentalApi: true } })
    this.write({ method: "initialized" })
  }

  async *events(): AsyncGenerator<RpcMessage> {
    while (true) {
      const message = this.messages.shift()
      if (message !== undefined) { yield message; continue }
      if (this.failure !== undefined) throw this.failure
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
  }

  close(error = new Error("Codex connection closed")): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.signal.removeEventListener("abort", this.onAbort)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.wake?.()
    this.child.kill()
  }
}
