import { Schema } from "effect"
import { refusal, readScript } from "../guard/bash.ts"
import { redactSecrets } from "./policy.ts"
import { runSandboxed, sandboxProgram } from "./sandbox.ts"

const Request = Schema.Struct({ command: Schema.String, branch: Schema.String, daemonPort: Schema.Number })
const Response = Schema.Struct({ reason: Schema.NullOr(Schema.String) })
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/** Script inspection gets the same kernel read boundary as execution, never a host filesystem callback. */
export const checkCommand = async (worktree: string, command: string, branch: string, daemonPort: number, signal: AbortSignal): Promise<string | undefined> => {
  const argv = [...sandboxProgram(), "--check-command", JSON.stringify({ command, branch, daemonPort })]
  const result = await runSandboxed(worktree, argv.map(quote).join(" "), signal, { readOnly: true, trustedHelper: true })
  if (result.exitCode !== 0) throw new Error("Command policy could not inspect this command; execution refused.")
  return Schema.decodeUnknownSync(Schema.fromJsonString(Response))(result.stdout).reason ?? undefined
}
export const commandPolicyMain = (raw: string): void => {
  const args = Schema.decodeUnknownSync(Schema.fromJsonString(Request))(raw)
  const reason = refusal(args.command, { cwd: process.cwd(), branch: args.branch, daemonPort: args.daemonPort, readFile: readScript })
  process.stdout.write(JSON.stringify({ reason: reason === undefined ? null : redactSecrets(reason) }))
}
