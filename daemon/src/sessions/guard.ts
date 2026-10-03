import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, resolve } from "node:path"
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk"
import { firstPositional, flags, REASONS } from "./guard-reasons.ts"
import { ghRefusal, gitRefusal } from "./guard-vcs.ts"
import { type Command, parseShell, type Word } from "./shell.ts"

export interface GuardContext {
  /** The session's own branch, the only one it may push. */
  readonly branch: string
  /** Where relative script paths resolve: the session worktree. */
  readonly cwd: string
  /** The daemon's port. Its API is the user's, not the agent's. */
  readonly daemonPort: number
  /** Reads a script the command would run, so its content is checked too. */
  readonly readFile: (path: string) => string | undefined
}

const MAX_SCRIPT_BYTES = 1_048_576

/** A script's text. A larger file is returned only as its head when that is binary, which is all the guard needs. */
export const readScript = (path: string): string | undefined => {
  try {
    if (statSync(path).size <= MAX_SCRIPT_BYTES) return readFileSync(path, "utf8")
    const fd = openSync(path, "r")
    try {
      const head = Buffer.alloc(4_096)
      const read = readSync(fd, head, 0, head.length, 0)
      return head.subarray(0, read).includes(0) ? head.subarray(0, read).toString("latin1") : undefined
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}


const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac"])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const CLUSTER = new Set(["kubectl", "helm", "argocd", "kargo"])
const GCP = new Set(["gcloud", "gsutil", "bq"])
const NETWORK = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "http", "https", "xh", "websocat", "grpcurl", "aria2c"])
/** Tools that take the port as its own argument (`nc 127.0.0.1 47621`). */
const PORT_ARGUMENT = new Set(["nc", "ncat", "netcat", "telnet"])
const SLACK_HOST = /(^|[^A-Za-z0-9-])([A-Za-z0-9-]+\.)*slack\.com(?![A-Za-z0-9-])/i
const MAX_DEPTH = 4

interface Scope extends GuardContext {
  /** Unknown after a `cd` to a computed directory. */
  readonly cwdKnown: boolean
  /** The whole command line, for words whose value is only known at runtime. */
  readonly source: string
  readonly depth: number
}

/** Why this command is refused, or `undefined` when it may run. */
export const refusal = (command: string, context: GuardContext): string | undefined =>
  check(command, { ...context, cwdKnown: true, source: command, depth: 0 })

const check = (source: string, scope: Scope): string | undefined => {
  if (scope.depth > MAX_DEPTH) return REASONS.nesting
  const parsed = parseShell(source)
  if (parsed._tag === "Unparsable") return `Bridgetown could not parse this command (${parsed.reason}). Simplify it.`
  let current: Scope = { ...scope, source }
  for (const command of parsed.commands) {
    const reason = checkCommand(command, current)
    if (reason !== undefined) return reason
    current = afterCd(command, current)
  }
  return undefined
}

const nested = (source: string, scope: Scope): string | undefined => check(source, { ...scope, depth: scope.depth + 1 })

/** `cd dir` moves where later relative script paths resolve. */
const afterCd = (command: Command, scope: Scope): Scope => {
  const [head, target] = command
  if (head?.text !== "cd") return scope
  if (target === undefined) return { ...scope, cwd: homedir() }
  if (target.dynamic || target.text === "-") return { ...scope, cwdKnown: false }
  return { ...scope, cwd: resolve(scope.cwd, expandHome(target.text)) }
}

const expandHome = (path: string): string => (path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path)

const literal = (words: ReadonlyArray<Word>): string | undefined =>
  words.some((word) => word.dynamic) ? undefined : words.map((word) => word.text).join(" ")


/** Commands that run another command: what follows their options is checked instead. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  command: flags(),
  builtin: flags(),
  exec: flags("-a"),
  nohup: flags(),
  time: flags(),
  nice: flags("-n", "--adjustment"),
  timeout: flags("-s", "--signal", "-k", "--kill-after"),
  stdbuf: flags("-i", "-o", "-e"),
  caffeinate: flags("-t", "-w"),
  chronic: flags(),
  unbuffer: flags(),
  xargs: flags("-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--max-chars", "--delimiter", "--arg-file", "--eof", "--replace", "--max-lines"),
  bunx: flags("-p", "--package"),
  npx: flags("-p", "--package"),
}

const checkCommand = (command: Command, scope: Scope): string | undefined => {
  let argv = [...command]
  while (argv.length > 0) {
    const first = argv[0]
    if (first === undefined) return undefined
    if (!first.quoted && (KEYWORDS.has(first.text) || ASSIGNMENT.test(first.text))) {
      argv = argv.slice(1)
      continue
    }
    if (first.dynamic) return REASONS.dynamic
    const name = basename(first.text)
    const args = argv.slice(1)
    const options = WRAPPERS[name]
    if (options !== undefined) {
      if (name === "command" && args.some((arg) => arg.text === "-v" || arg.text === "-V")) return undefined
      if ((name === "npx" || name === "bunx") && args.some((arg) => arg.text === "-c" || arg.text === "--call")) {
        const call = args[args.findIndex((arg) => arg.text === "-c" || arg.text === "--call") + 1]
        return call === undefined ? undefined : call.dynamic ? REASONS.dynamic : nested(call.text, scope)
      }
      let rest = args.slice(firstPositional(args, options))
      // `timeout 30 cmd`, `nice -10 cmd`: the duration is positional.
      if (name === "timeout") rest = rest.slice(1)
      // `bunx prisma@5 migrate` runs `prisma`.
      const [runs, ...runArgs] = rest
      if (runs !== undefined && (name === "bunx" || name === "npx")) {
        rest = [{ ...runs, text: runs.text.replace(/(.)@[^/]*$/, "$1") }, ...runArgs]
      }
      argv = rest
      continue
    }
    if (name === "env") {
      const split = args.findIndex((arg) => arg.text === "-S" || arg.text.startsWith("--split-string"))
      if (split !== -1) {
        const value = args[split]?.text.startsWith("--split-string=") ? args[split] : args[split + 1]
        const text = value?.text.replace(/^--split-string=/, "")
        if (value === undefined || text === undefined) return undefined
        return value.dynamic ? REASONS.dynamic : nested([text, ...args.slice(split + 2).map((arg) => arg.text)].join(" "), scope)
      }
      argv = args.slice(firstPositional(args, flags("-u", "--unset", "-C", "--chdir")))
      continue
    }
    return commandRefusal(name, first, args, scope)
  }
  return undefined
}

const commandRefusal = (name: string, head: Word, args: ReadonlyArray<Word>, scope: Scope): string | undefined => {
  if (name === "sudo" || name === "su" || name === "doas") return REASONS.privilege
  if (CLUSTER.has(name)) return REASONS.cluster
  if (GCP.has(name)) return REASONS.gcp
  if (name === "op") return REASONS.secrets
  if (name === "security" && args.some((arg) => /^(find-(generic|internet)-password|dump-keychain|export)$/.test(arg.text))) return REASONS.secrets
  if (name === "cast" && (args[0]?.text === "send" || args[0]?.text === "publish")) return REASONS.transaction
  if (name === "prisma" && (args[0]?.text === "migrate" || (args[0]?.text === "db" && args[1]?.text === "push"))) return REASONS.migration
  if (name === "bun" || name === "npm" || name === "pnpm" || name === "yarn") return packageManagerRefusal(args, scope)
  if (NETWORK.has(name)) return networkRefusal(name, args, scope)
  if (name === "gh") return ghRefusal(args)
  if (name === "git") return gitRefusal(args, scope.branch)
  if (name === "eval") {
    const text = literal(args)
    return text === undefined ? REASONS.dynamic : nested(text, scope)
  }
  if (SHELLS.has(name)) return shellRefusal(args, scope)
  if (name === "source" || name === ".") return args[0] === undefined ? undefined : scriptRefusal(args[0], scope, true)
  if (name === "watch") {
    const text = literal(args.slice(firstPositional(args, flags("-n", "--interval", "-q", "--equexit"))))
    return text === undefined ? REASONS.dynamic : nested(text, scope)
  }
  if (name === "find") return findRefusal(args, scope)
  if (name === "alias") {
    for (const arg of args) {
      const at = arg.text.indexOf("=")
      if (at === -1) continue
      const reason = arg.dynamic ? REASONS.dynamic : nested(arg.text.slice(at + 1), scope)
      if (reason !== undefined) return reason
    }
    return undefined
  }
  // A path to something not refused by name: a script runs whatever it contains.
  if (head.text.includes("/")) return scriptRefusal(head, scope, false)
  return undefined
}

const packageManagerRefusal = (args: ReadonlyArray<Word>, scope: Scope): string | undefined => {
  const [sub, ...rest] = args
  if (sub === undefined) return undefined
  // `bun x`, `pnpm dlx`, `npm exec`: another command runs.
  if (["x", "exec", "dlx"].includes(sub.text)) {
    const inner = rest.slice(firstPositional(rest, flags("-p", "--package")))
    return inner.length === 0 ? undefined : checkCommand(inner, scope)
  }
  const script = sub.text === "run" || sub.text === "run-script" ? rest.find((arg) => !arg.text.startsWith("-"))?.text : sub.text
  return script !== undefined && /^(migrate|db:push|db:migrate)\b/.test(script) ? REASONS.migration : undefined
}

const networkRefusal = (name: string, args: ReadonlyArray<Word>, scope: Scope): string | undefined => {
  const port = String(scope.daemonPort)
  const daemonPort = new RegExp(`:${port}(?![0-9])`)
  // A computed argument could expand to anything on the line, so the whole line is checked.
  const texts = args.some((arg) => arg.dynamic) ? [...args.map((arg) => arg.text), scope.source] : args.map((arg) => arg.text)
  for (const text of texts) {
    if (/\.internal\.merkl\.xyz/i.test(text)) return REASONS.internal
    if (SLACK_HOST.test(text)) return REASONS.slack
    if (daemonPort.test(text)) return REASONS.daemon
  }
  if (PORT_ARGUMENT.has(name) && args.some((arg) => arg.text === port)) return REASONS.daemon
  return undefined
}

const shellRefusal = (args: ReadonlyArray<Word>, scope: Scope): string | undefined => {
  let command = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) break
    const text = arg.text
    if (text === "--version" || text === "--help") return undefined
    if (text === "--") {
      const script = args[i + 1]
      return script === undefined ? REASONS.pipeToShell : command ? checkString(script, scope) : scriptRefusal(script, scope, true)
    }
    if (text === "-o" || text === "+o" || text === "-O" || text === "+O" || text === "--rcfile" || text === "--init-file") {
      i++
      continue
    }
    if (/^[-+][a-zA-Z]+$/.test(text)) {
      if (text.startsWith("-") && text.includes("c")) command = true
      if (text.startsWith("-") && text.includes("s")) return REASONS.pipeToShell
      continue
    }
    if (text.startsWith("--")) continue
    return command ? checkString(arg, scope) : scriptRefusal(arg, scope, true)
  }
  return REASONS.pipeToShell
}

const checkString = (word: Word, scope: Scope): string | undefined => (word.dynamic ? REASONS.dynamic : nested(word.text, scope))

/** `find … -exec cmd {} ;` runs `cmd`. */
const findRefusal = (args: ReadonlyArray<Word>, scope: Scope): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i]?.text ?? "")) continue
    const end = args.findIndex((arg, j) => j > i && (arg.text === ";" || arg.text === "+"))
    const inner = args.slice(i + 1, end === -1 ? undefined : end)
    const reason = checkCommand(inner, scope)
    if (reason !== undefined) return reason
  }
  return undefined
}

const SHELL_SHEBANG = /^#!\s*\S*(\/|\s)(env\s+)?(ba|z|da|k)?sh\b/

/**
 * A script runs whatever it contains, so its content goes through the same
 * guard. `bash x.sh` and `source x.sh` are always shell; a file executed by path
 * is checked when it is a shell script (shebang or none). Binaries and other
 * interpreters are beyond what a command-line check can see.
 */
const scriptRefusal = (path: Word, scope: Scope, shell: boolean): string | undefined => {
  if (path.dynamic) return REASONS.dynamic
  const expanded = expandHome(path.text)
  if (!isAbsolute(expanded) && !scope.cwdKnown) return `Bridgetown cannot tell which ${path.text} this runs. Use a path from your worktree.`
  const content = scope.readFile(isAbsolute(expanded) ? expanded : resolve(scope.cwd, expanded))
  if (content === undefined) return `Bridgetown could not read ${path.text} to check what it runs.`
  const head = content.slice(0, 4_096)
  if (!shell && (head.includes("\u0000") || (head.startsWith("#!") && !SHELL_SHEBANG.test(head)))) return undefined
  const reason = nested(content, scope)
  return reason === undefined ? undefined : `${path.text} runs a refused command. ${reason}`
}

export const commandOf = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null || !("command" in input)) return undefined
  return typeof input.command === "string" ? input.command : undefined
}

export const bashGuard = (context: GuardContext, onDeny: (command: string, reason: string) => void): HookCallback =>
  async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {}
    const command = commandOf(input.tool_input)
    if (command === undefined) return {}
    const reason = refusal(command, context)
    if (reason === undefined) return {}
    onDeny(command, reason)
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }
  }
