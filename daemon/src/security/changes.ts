import { createHash } from "node:crypto"
import { closeSync, lstatSync, openSync, readSync, readlinkSync } from "node:fs"
import { resolve } from "node:path"
import { z } from "zod"
import { CREDENTIAL_NAMES } from "./policy.ts"
import { runSandboxed, sandboxProgram } from "./sandbox.ts"

const Entry = z.object({ path: z.string().min(1).max(4096), mode: z.string(), oid: z.string().nullable() }).strict()
const Entries = z.array(Entry).max(100_000)
export type TreeEntry = z.infer<typeof Entry>
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/** Compare raw working bytes to immutable tree entries under Seatbelt; never invoke Git clean filters. */
export const changedPaths = async (worktree: string, entries: ReadonlyArray<TreeEntry>, signal: AbortSignal): Promise<Array<string>> => {
  const command = [...sandboxProgram(), "--changed-files"].map(quote).join(" ")
  const result = await runSandboxed(worktree, command, signal, { readOnly: true, trustedHelper: true, stdin: JSON.stringify(entries) })
  if (result.exitCode !== 0) throw new Error("Cannot inspect the worktree safely. Narrow or hand off this fix.")
  return z.array(z.string()).parse(JSON.parse(result.stdout))
}
export const changedPathsMain = async (): Promise<void> => {
  const entries = Entries.parse(JSON.parse(await new Response(Bun.stdin.stream()).text()))
  const changed: Array<string> = []
  for (const entry of entries) {
    if (entry.oid === null) { changed.push(entry.path); continue }
    // Credential files are kernel-protected and cannot be read or edited by generated code.
    // Preserve their existing tree entries without inspecting their contents.
    if (entry.path.split(/[\\/]/).some((part) => CREDENTIAL_NAMES.some((name) => name === ".env*" ? part.toLowerCase().startsWith(".env") : name.toLowerCase() === part.toLowerCase()))) continue
    const at = resolve(process.cwd(), entry.path)
    try {
      const stat = lstatSync(at)
      const mode = stat.isSymbolicLink() ? "120000" : stat.isFile() ? stat.mode & 0o111 ? "100755" : "100644" : "unsupported"
      if (mode !== entry.mode || stat.size > 50 * 1024 * 1024) { changed.push(entry.path); continue }
      const hash = createHash(entry.oid.length === 64 ? "sha256" : "sha1")
      if (stat.isSymbolicLink()) {
        const content = Buffer.from(readlinkSync(at))
        hash.update(`blob ${content.length}\0`).update(content)
      } else {
        const fd = openSync(at, "r")
        try {
          hash.update(`blob ${stat.size}\0`)
          const buffer = Buffer.alloc(8192)
          let bytes = 0
          for (;;) {
            const count = readSync(fd, buffer, 0, buffer.length, null)
            if (count === 0) break
            bytes += count
            if (bytes > 50 * 1024 * 1024) throw new Error("File grew beyond comparison budget.")
            hash.update(buffer.subarray(0, count))
          }
        } finally { closeSync(fd) }
      }
      if (hash.digest("hex") !== entry.oid) changed.push(entry.path)
    } catch { changed.push(entry.path) }
  }
  process.stdout.write(JSON.stringify(changed))
}
