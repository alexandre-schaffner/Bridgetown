import { readFileSync, readdirSync, statSync, lstatSync, mkdirSync, writeFileSync } from "node:fs"
import { join, relative, dirname, resolve } from "node:path"
import { Effect } from "effect"
import { git, runOk } from "../lib/proc.ts"
import { z } from "zod"
import { BrokerRequest } from "./capabilities.ts"
import { MAX_TOOL_BYTES, assertNoSecrets, evidence, protectedPath, readablePath } from "./policy.ts"

import { runSandboxed, sandboxProgram } from "./sandbox.ts"
import { writeRefusal } from "../guard/confine.ts"

/** Shared by investigators and reviewers; neither can read host credentials. */
const fileOperation = (worktree: string, input: BrokerRequest): string => {
  if (input.tool === "write_file") {
    const reason = writeRefusal("Write", { file_path: input.args.path }, worktree)
    if (reason !== undefined || protectedPath(input.args.path)) throw new Error(reason ?? "This path is protected.")
    assertNoSecrets(input.args.content)
    const path = resolve(worktree, input.args.path)
    mkdirSync(dirname(path), { recursive: true })
    const after = writeRefusal("Write", { file_path: input.args.path }, worktree)
    if (after !== undefined) throw new Error(after)
    writeFileSync(path, input.args.content, { mode: 0o600 })
    return "Written in this investigation's worktree."
  }
  if (input.tool === "read_file") {
    const path = readablePath(worktree, input.args.path)
    if (!statSync(path).isFile() || statSync(path).size > MAX_TOOL_BYTES) throw new Error("File too large; narrow the request.")
    return evidence(`File ${input.args.path}`, readFileSync(path, "utf8"))
  }
  if (input.tool !== "list_files") throw new Error("Only scoped file reads are authorized here.")
  const path = readablePath(worktree, input.args.path ?? ".")
  const files: Array<string> = []
  let visited = 0
  const walk = (directory: string, depth: number): void => {
    if (depth > 30) throw new Error("File tree is too deep; narrow the directory.")
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++visited > 5000) throw new Error("Too many entries; narrow the directory.")
      if (entry.isSymbolicLink() || protectedPath(entry.name) || ["node_modules", ".shared", ".context", ".repos"].includes(entry.name)) continue
      const at = join(directory, entry.name)
      if (entry.isDirectory()) walk(at, depth + 1)
      else if (entry.isFile()) files.push(relative(worktree, at))
      if (files.length > 1000) throw new Error("Too many files; narrow the directory.")
    }
  }
  walk(path, 0)
  return evidence("Source file list", files.sort().join("\n"))
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/** File operations run under the kernel boundary too, including during a symlink replacement race. */
export const fileBroker = async (worktree: string, input: BrokerRequest, signal: AbortSignal): Promise<string> => {
  if (!["read_file", "list_files", "write_file"].includes(input.tool)) throw new Error("Only scoped file operations are authorized here.")
  const command = [...sandboxProgram(), "--file-tool", JSON.stringify(input)].map(quote).join(" ")
  const result = await runSandboxed(worktree, command, signal, { readOnly: input.tool !== "write_file", trustedHelper: true })
  if (result.exitCode !== 0) throw new Error("Scoped file operation failed: check its path, type and size.")
  return result.stdout
}
export const readBroker = (worktree: string, input: BrokerRequest, signal: AbortSignal): Promise<string> => {
  if (input.tool !== "read_file" && input.tool !== "list_files") return Promise.reject(new Error("Only scoped reads are authorized here."))
  return fileBroker(worktree, input, signal)
}
export const fileToolMain = (raw: string): void => {
  process.stdout.write(fileOperation(process.cwd(), BrokerRequest.parse(JSON.parse(raw))))
}

const Snapshot = z.array(z.object({ path: z.string(), content: z.string().nullable(), mode: z.enum(["100644", "100755"]) }).strict()).max(1000)
export type Snapshot = z.infer<typeof Snapshot>

/** The publication input is captured under Seatbelt, then staged from these exact bytes, never git add. */
export const snapshotFiles = async (worktree: string, paths: ReadonlyArray<string>, signal: AbortSignal): Promise<Snapshot> => {
  const command = [...sandboxProgram(), "--snapshot-files", JSON.stringify(paths)].map(quote).join(" ")
  const result = await runSandboxed(worktree, command, signal, { readOnly: true, trustedHelper: true })
  if (result.exitCode !== 0) throw new Error("Cannot snapshot this fix. Only bounded UTF-8 regular files are publishable.")
  return Snapshot.parse(JSON.parse(result.stdout))
}
export const snapshotFilesMain = (raw: string): void => {
  const paths = z.array(z.string().min(1).max(4096)).max(1000).parse(JSON.parse(raw))
  const snapshot = paths.map((path) => {
    if (protectedPath(path)) throw new Error("Protected path.")
    try {
      const at = readablePath(process.cwd(), path)
      const stat = lstatSync(resolve(process.cwd(), path))
      if (!stat.isFile() || stat.size > MAX_TOOL_BYTES) throw new Error("Only bounded regular files.")
      const content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(at))
      if (content.includes("\0")) throw new Error("Binary fix requires human publication.")
      return { path, content, mode: stat.mode & 0o111 ? "100755" : "100644" }
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return { path, content: null, mode: "100644" }
      throw cause
    }
  })
  process.stdout.write(JSON.stringify(snapshot))
}

/** Reviewers see only immutable Git objects at the reviewed SHA, never mutable working files or diff drivers. */
export const readCommitBroker = async (worktree: string, head: string, input: BrokerRequest, signal: AbortSignal): Promise<string> => {
  if (input.tool !== "read_file" && input.tool !== "list_files") throw new Error("Only pinned source reads are authorized for review.")
  const path = input.args.path ?? "."
  if (!/^[0-9a-f]{40,64}$/.test(head) || path.startsWith("/") || path.includes("\0") || path.split(/[\\/]/).includes("..") || protectedPath(path)) throw new Error("Only scoped source paths at the reviewed commit are authorized.")
  const command = input.tool === "read_file" ? git("show", `${head}:${path}`) : git("ls-tree", "-r", "--name-only", head, "--", path)
  const text = await Effect.runPromise(runOk(command, { cwd: worktree, timeoutMs: 30_000, maxOutputBytes: MAX_TOOL_BYTES }), { signal })
  return evidence(`Reviewed commit ${head.slice(0, 7)} ${path}`, input.tool === "read_file" ? text : text.split("\n").filter((file) => !protectedPath(file)).join("\n"))
}
