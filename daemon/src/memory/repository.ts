import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"
import { AdapterError, errorMessage } from "../domain/errors.ts"
import { makeKeyedLock } from "../lib/keyed-lock.ts"
import { git, runOk } from "../lib/proc.ts"

export const Checkpoint = Schema.Struct({
  mode: Schema.Literals(["learn", "dream"]), events: Schema.Array(Schema.String), at: Schema.String, input: Schema.String,
})
export type Checkpoint = typeof Checkpoint.Type
export interface MemorySource { readonly category: string; readonly origin?: string }
export interface MemorySnapshot { readonly head: string; readonly files: Readonly<Record<string, string>> }
export const Changes = Schema.Struct({ changes: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.NullOr(Schema.String) })) })
export type Changes = typeof Changes.Type
const MARKER = "Bridgetown-Memory: "
const INITIAL = "# Bridgetown memory\n\n## Index\n"
const fileLimit = (path: string) => path === "MEMORY.md" ? 4_096 : 16_384

const fail = (message: string) => new AdapterError({ adapter: "memory", operation: "repository", message, cause: null })
const filesystem = <A>(f: () => A) => Effect.try({ try: f, catch: (cause) => fail(errorMessage(cause)) })

/** Only Markdown paths rooted in the memory repo, with no symlink component or Git/control path. */
export const memoryPath = (root: string, path: string): string => {
  if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(path)) throw fail(`Invalid memory path: ${path}`)
  const parts = path.split("/")
  for (let i = 1; i <= parts.length; i++) {
    const component = join(root, ...parts.slice(0, i))
    if (existsSync(component) && lstatSync(component).isSymbolicLink()) throw fail(`Symlink in memory path: ${path}`)
  }
  return join(root, path)
}

const readFiles = (root: string): Record<string, string> => {
  const files: Record<string, string> = {}
  let size = 0
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`
      if (entry.isSymbolicLink()) throw fail(`Symlink in memory repo: ${path}`)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && path.endsWith(".md")) {
        const file = memoryPath(root, path)
        const bytes = lstatSync(file).size
        if (bytes > fileLimit(path)) throw fail(`Memory file exceeds ${fileLimit(path)} UTF-8 bytes: ${path}`)
        const content = readFileSync(file, "utf8")
        size += bytes
        if (size > 2_000_000 || Object.keys(files).length >= 128) throw fail("Memory repo exceeds its read budget")
        files[path] = content
      }
    }
  }
  visit("")
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
}

/** Validate the entire proposed wiki before changing a single file. */
export const validateChanges = (snapshot: MemorySnapshot, proposal: Changes, sources: ReadonlyMap<string, MemorySource>): Record<string, string> => {
  if (proposal.changes.length > 8) throw fail("A memory job may change at most eight files")
  const next = { ...snapshot.files }
  const changed = new Set<string>()
  for (const { path, content } of proposal.changes) {
    memoryPath("/memory", path)
    if (changed.has(path)) throw fail(`Repeated memory path: ${path}`)
    changed.add(path)
    if (content === null) {
      if (snapshot.files[path] === undefined || path === "MEMORY.md") throw fail(`Cannot remove ${path}`)
      delete next[path]
      continue
    }
    if (Buffer.byteLength(content, "utf8") > fileLimit(path)) throw fail(`Memory file too large: ${path}`)
    const existing = new Set((snapshot.files[path] ?? "").split("\n"))
    const lines = content.split("\n")
    let inIndex = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      if (line.startsWith("#")) {
        inIndex = /^#{1,6}\s+Index\s*#*\s*$/i.test(line)
        continue
      }
      if (!line.trim() || /^- \[\[[\w/-]+\]\]$/.test(line)) continue
      if (!line.startsWith("- ")) throw fail("Memory entries must be one-line bullets")
      // Index labels are navigation, not facts. Discard labels rather than retaining unattributed prose.
      const indexLink = inIndex ? /^- [^\[\]]*\[\[([\w/-]+)\]\][^\[\]]*$/.exec(line) : null
      if (indexLink !== null) {
        lines[i] = `- [[${indexLink[1]}]]`
        continue
      }
      if (existing.has(line)) continue
      const metadata = /\[source: ([^;\]]+); added: \d{4}-\d{2}-\d{2}; evidence: (user statement|source statement|observed workflow|agent claim)(?:; origin: [^\]]+)?\]$/.exec(line)
      const source = metadata?.[1]
      if (source === undefined || sources.get(source)?.category !== metadata?.[2]) throw fail(`New memory entry lacks a supported source, date, or correct evidence category (${path}:${i + 1})`)
      const origin = sources.get(source)?.origin
      if (origin !== undefined) {
        const safe = origin.replace(/[;\]\r\n]/g, (character) => encodeURIComponent(character))
        lines[i] = line.replace(/(?:; origin: [^\]]+)?\]$/, `; origin: ${safe}]`)
      }
    }
    const normalized = lines.join("\n")
    if (Buffer.byteLength(normalized, "utf8") > fileLimit(path)) throw fail(`Memory file too large after source attribution: ${path}`)
    next[path] = normalized
  }
  if (next["MEMORY.md"] === undefined) throw fail("MEMORY.md is required")
  for (const content of Object.values(next)) for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const linked = `${match[1]}.md`
    if (next[linked] === undefined) throw fail(`Broken memory link: ${match[1]}`)
  }
  if (Object.keys(next).length > 128 || Object.values(next).reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0) > 2_000_000) throw fail("Memory repo exceeds its read budget")
  return next
}

export const memoryRepository = (root: string) => {
  const initialization = makeKeyedLock()
  const command = (...args: ReadonlyArray<string>) => runOk(git("-c", "user.name=Bridgetown", "-c", "user.email=memory@bridgetown.local", "-c", "commit.gpgsign=false", ...args), { cwd: root })
  const ensure = Effect.gen(function* () {
    const initialize = yield* filesystem(() => {
      if (existsSync(root) && (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())) throw fail("Memory root must be a directory, not a symlink")
      mkdirSync(root, { recursive: true, mode: 0o700 })
      if (existsSync(join(root, ".git"))) return false
      if (readdirSync(root).length !== 0) throw fail("Memory directory is non-empty and is not a memory repository")
      return true
    })
    if (initialize) {
      yield* command("init")
      yield* filesystem(() => writeFileSync(join(root, "MEMORY.md"), INITIAL, { mode: 0o600 }))
      yield* command("add", "--", "MEMORY.md")
      yield* command("commit", "-m", "Create Bridgetown memory")
    }
    const top = (yield* command("rev-parse", "--show-toplevel")).trim()
    yield* filesystem(() => {
      if (realpathSync(top) !== realpathSync(root) || !existsSync(memoryPath(root, "MEMORY.md"))) throw fail("Not a standalone memory repository")
      const gitPath = join(root, ".git")
      if (lstatSync(gitPath).isSymbolicLink() || !lstatSync(gitPath).isDirectory()) throw fail("Memory must use its own local Git directory")
    })
  })
  const initialized = ensure.pipe(initialization.withLock("init"))
  const snapshot = Effect.gen(function* () {
    yield* initialized
    const head = (yield* command("rev-parse", "HEAD")).trim()
    const files = yield* filesystem(() => readFiles(root))
    return { head, files }
  })
  const clean = Effect.gen(function* () {
    if ((yield* command("status", "--porcelain")).trim() !== "") return yield* fail("Memory has uncommitted edits. Commit your Markdown corrections before automatic learning can continue.")
  })
  return {
    root, snapshot,
    history: (since?: string) => Effect.gen(function* () {
      yield* initialized
      const log = yield* command("log", "--format=%H%x00%B%x00", ...(since === undefined ? [] : [`${since}..HEAD`]))
      const chunks = log.split("\0")
      const checkpoints: Array<{ readonly head: string; readonly checkpoint: Checkpoint }> = []
      for (let i = 0; i + 1 < chunks.length; i += 2) {
        const body = chunks[i + 1] ?? ""
        const marker = body.split("\n").find((line) => line.startsWith(MARKER))
        if (marker === undefined) continue
        const checkpoint = yield* filesystem(() => Schema.decodeUnknownSync(Schema.fromJsonString(Checkpoint))(marker.slice(MARKER.length)))
        checkpoints.push({ head: (chunks[i] ?? "").trim(), checkpoint })
      }
      return checkpoints.reverse()
    }),
    clean,
    apply: (before: MemorySnapshot, proposal: Changes, checkpoint: Checkpoint, sources: ReadonlyMap<string, MemorySource>) => Effect.gen(function* () {
      yield* clean
      const current = yield* snapshot
      if (current.head !== before.head || JSON.stringify(current.files) !== JSON.stringify(before.files)) return yield* fail("Memory changed during the job; retrying against the new version")
      const next = yield* filesystem(() => validateChanges(before, proposal, sources))
      yield* filesystem(() => {
        for (const { path } of proposal.changes) {
          const file = memoryPath(root, path)
          if (next[path] === undefined) rmSync(file)
          else {
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
            // A private temporary file in the same directory makes each replacement atomic.
            const temp = `${file}.bridgetown-tmp`
            writeFileSync(temp, next[path], { mode: 0o600, flag: "wx" })
            renameSync(temp, file)
          }
        }
      })
      if (proposal.changes.length > 0) yield* command("add", "--", ...proposal.changes.map((change) => change.path))
      const expected = new Set(proposal.changes.map((change) => change.path))
      const status = yield* command("status", "--porcelain", "--untracked-files=all")
      if (status.split("\n").some((line) => line !== "" && !expected.has(line.slice(3)))) return yield* fail("Unrelated edits appeared during the memory commit; leaving them untouched")
      const staged = yield* filesystem(() => readFiles(root))
      const sorted = (files: Readonly<Record<string, string>>) => JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))
      if (sorted(staged) !== sorted(next)) return yield* fail("Memory was edited while preparing the commit; leaving the edits untouched")
      yield* command("commit", "--allow-empty", "-m", `${checkpoint.mode === "dream" ? "Consolidate" : "Learn"} memory\n\n${MARKER}${JSON.stringify(checkpoint)}`, ...(proposal.changes.length === 0 ? [] : ["--only", "--", ...proposal.changes.map((change) => change.path)]))
      return (yield* command("rev-parse", "HEAD")).trim()
    }),
  }
}

export const recall = (snapshot: MemorySnapshot, query: string, limit = 12_000): string => {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])].slice(0, 100)
  const ranked = Object.entries(snapshot.files).filter(([path]) => path !== "MEMORY.md").map(([path, content]) => ({
    path, content, score: terms.reduce((sum, term) => sum + (path.toLowerCase().includes(term) ? 3 : 0) + (content.toLowerCase().includes(term) ? 1 : 0), 0),
  })).filter((file) => file.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  if (!/^-/m.test(snapshot.files["MEMORY.md"] ?? "") && ranked.length === 0) return ""
  let remaining = limit
  const sections: Array<string> = []
  for (const { path, content } of [{ path: "MEMORY.md", content: snapshot.files["MEMORY.md"] ?? "" }, ...ranked.slice(0, 8)]) {
    if (remaining <= path.length + 3) break
    const lines: Array<string> = []
    remaining -= path.length + 3
    for (const line of content.split("\n")) {
      // Never cut a fact off from the source metadata at the end of its line.
      if (line.length + 1 > remaining) continue
      lines.push(line)
      remaining -= line.length + 1
    }
    sections.push(`${path}\n${lines.join("\n")}`)
  }
  return sections.join("\n\n")
}
