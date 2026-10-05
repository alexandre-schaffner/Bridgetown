import { closeSync, openSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, resolve } from "node:path"
import { firstPositional, flags, REASONS, runsNothing } from "./guard-reasons.ts"
import { ghRefusal, githubApiWriteRefusal, gitRefusal } from "./guard-vcs.ts"
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

/**
 * A script's text. Only regular files are read: a character device or FIFO
 * (`/dev/zero`, `/dev/stdin`, a `mkfifo` path) reports size 0 but would block
 * or exhaust memory if streamed, and is never a script the agent wrote. Reading
 * is capped with an explicit `readSync` rather than `readFileSync` so size can
 * never grow unbounded between the stat and the read; a file over the cap is
 * returned only as its binary head, which is all the guard needs.
 */
export const readScript = (path: string): string | undefined => {
  try {
    if (!statSync(path).isFile()) return undefined
    const fd = openSync(path, "r")
    try {
      const buffer = Buffer.alloc(MAX_SCRIPT_BYTES + 1)
      const read = readSync(fd, buffer, 0, buffer.length, 0)
      const bytes = buffer.subarray(0, read)
      if (read > MAX_SCRIPT_BYTES) return bytes.includes(0) ? bytes.toString("latin1") : undefined
      return bytes.toString("utf8")
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}


const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac", "coproc"])
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/
/** Variables whose value is a command a later program runs (an ssh, pager, editor or askpass): only one that runs nothing may be set (`GIT_EDITOR=true`, `PAGER=cat`). */
const COMMAND_ENV = /^(GIT_SSH_COMMAND|GIT_SSH|GIT_EXTERNAL_DIFF|GIT_PAGER|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PROXY_COMMAND|GIT_ASKPASS|SSH_ASKPASS|PAGER|GH_PAGER|EDITOR|VISUAL|GH_EDITOR)$/
/** Variables no value of which is safe: a startup file or option string a shell or runtime runs, an injected library, git's config, exec path and hook templates, an exported bash function (`env 'BASH_FUNC_git%%=() {…}'`). */
const LOADER_ENV =
  /^(BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|BASH_FUNC_.*|GIT_CONFIG_PARAMETERS|GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|NODE_OPTIONS|BUN_OPTIONS|PERL5OPT|PERL5LIB|PYTHONSTARTUP|RUBYOPT)$/
/** Builtins that set variables from their `NAME=value` arguments. */
const DECLARATIONS = new Set(["export", "declare", "typeset", "local", "readonly"])
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh", "yash", "oksh", "posh", "busybox", "pwsh", "nu", "xonsh", "elvish"])
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
  setsid: flags(),
  noglob: flags(),
  nocorrect: flags(),
  arch: flags("-arch", "-d", "-e"),
  parallel: flags("-j", "-P", "-n", "-N"),
  // `script -q out cmd …`: the command follows the file operand; `-a`/`-t`/`-T` take a value.
  script: flags("-a", "-t", "-T"),
  xargs: flags("-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--max-chars", "--delimiter", "--arg-file", "--eof", "--replace", "--max-lines"),
  bunx: flags("-p", "--package"),
  npx: flags("-p", "--package"),
}

/** The replacement string `xargs -I R` / `--replace=R` substitutes per input line; words containing it are only known at runtime. */
const xargsReplstr = (args: ReadonlyArray<Word>): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    const text = args[i]?.text ?? ""
    if (text === "-I" || text === "--replace" || text === "-i") return args[i + 1]?.text
    if (text.startsWith("--replace=")) return text.slice("--replace=".length)
    if (/^-I./.test(text)) return text.slice(2)
  }
  return undefined
}

/** A word whose value is only known at runtime, appended so a wrapper that feeds extra arguments (xargs from stdin) cannot smuggle a subcommand past the gate. */
const RUNTIME_WORD: Word = { text: "", dynamic: true, quoted: false }

const checkCommand = (command: Command, scope: Scope): string | undefined => {
  let argv = [...command]
  while (argv.length > 0) {
    const first = argv[0]
    if (first === undefined) return undefined
    if (!first.quoted && KEYWORDS.has(first.text)) {
      argv = argv.slice(1)
      continue
    }
    // A leading `NAME=value` is an environment assignment, not the command. Quoting of the value does not change that (`GIT_SSH_COMMAND='…' git fetch`), so it is stripped even when the word is marked quoted.
    if (ASSIGNMENT.test(first.text)) {
      const reason = assignmentRefusal(first)
      if (reason !== undefined) return reason
      argv = argv.slice(1)
      continue
    }
    if (first.dynamic) return REASONS.dynamic
    // zsh runs `=cmd` as its resolved path; strip the prefix so the command is seen.
    const name = basename(first.quoted ? first.text : first.text.replace(/^=/, ""))
    const args = argv.slice(1)
    const options = WRAPPERS[name]
    if (options !== undefined) {
      // `command -v`/`-V` only look a command up; the flag must precede the command, not be one of its own arguments.
      if (name === "command" && args.slice(0, firstPositional(args, options)).some((arg) => arg.text === "-v" || arg.text === "-V")) return undefined
      if ((name === "npx" || name === "bunx") && args.some((arg) => arg.text === "-c" || arg.text === "--call" || arg.text.startsWith("--call="))) {
        const at = args.findIndex((arg) => arg.text === "-c" || arg.text === "--call" || arg.text.startsWith("--call="))
        const flag = args[at]
        const call = flag?.text.startsWith("--call=") ? { ...flag, text: flag.text.slice("--call=".length) } : args[at + 1]
        return call === undefined ? undefined : call.dynamic ? REASONS.dynamic : nested(call.text, scope)
      }
      let rest = args.slice(firstPositional(args, options))
      // `timeout 30 cmd`, `script -q out cmd`: a positional operand precedes the command.
      if (name === "timeout" || name === "script") rest = rest.slice(1)
      // With a command, xargs appends words from stdin the guard never sees, and -I substitutes them into the template, so a runtime word is appended and -I slots are marked dynamic. With no command it runs `echo` on its stdin, where there is nothing to smuggle a subcommand into.
      if (name === "xargs" && rest.length > 0) {
        const replstr = xargsReplstr(args)
        rest = [...rest.map((word) => (replstr !== undefined && replstr !== "" && word.text.includes(replstr) ? { ...word, dynamic: true } : word)), RUNTIME_WORD]
      }
      // `bunx prisma@5 migrate` runs `prisma`.
      const [runs, ...runArgs] = rest
      if (runs !== undefined && (name === "bunx" || name === "npx")) {
        rest = [{ ...runs, text: runs.text.replace(/(.)@[^/]*$/, "$1") }, ...runArgs]
      }
      argv = rest
      continue
    }
    if (name === "env") return envRefusal(args, scope)
    return commandRefusal(name, first, args, scope)
  }
  return undefined
}

/** Why setting `name` is refused; `value` is what it is set to, `undefined` when unknown (computed, appended, or exported as it already is). */
const variableRefusal = (name: string, value: string | undefined): string | undefined => {
  if (LOADER_ENV.test(name)) return REASONS.dangerousEnv
  return COMMAND_ENV.test(name) && (value === undefined || !runsNothing(value)) ? REASONS.dangerousEnv : undefined
}

/** `NAME=value` or `NAME+=value`, whether a prefix, an `env` argument or a `declare`/`export` one. The name ends at the first `=`: `env` takes any such word as an assignment, a bash function's `BASH_FUNC_git%%` included. */
const assignmentRefusal = (word: Word): string | undefined => {
  const eq = word.text.indexOf("=")
  const append = word.text[eq - 1] === "+"
  return variableRefusal(word.text.slice(0, append ? eq - 1 : eq), append || word.dynamic ? undefined : word.text.slice(eq + 1))
}

/** `$(…)` or a backtick in an argument. */
const substitutes = (word: Word): boolean => /\$\(|`/.test(word.text)

/**
 * `export NAME=value` and `declare`/`local`/`readonly NAME=value` set a variable as
 * surely as a prefix does. Exporting a dangerous name bare passes on a value set where
 * the guard never saw it (`read GIT_SSH_COMMAND; export GIT_SSH_COMMAND`), and a
 * computed name could be any. The integer forms (`declare -i`) evaluate their arguments
 * as arithmetic, which runs any `$(…)` inside, even quoted (`declare -i y='$(…)'`); a
 * plain `local x=$(…)` is an ordinary substitution the parser has already checked.
 */
const declarationRefusal = (name: string, args: ReadonlyArray<Word>): string | undefined => {
  const options = args.filter((arg) => arg.text.startsWith("-")).map((arg) => arg.text)
  if (options.some((option) => /^-[a-zA-Z]*i/.test(option)) && args.some(substitutes)) return REASONS.dynamic
  const exporting = name === "export" || options.some((option) => /^-[a-zA-Z]*x/.test(option))
  for (const arg of args) {
    if (arg.text.startsWith("-")) continue
    const reason = ASSIGNMENT.test(arg.text)
      ? assignmentRefusal(arg)
      : arg.dynamic
        ? REASONS.dynamic
        : exporting
          ? variableRefusal(arg.text, undefined)
          : undefined
    if (reason !== undefined) return reason
  }
  return undefined
}

const ENV_VALUE_FLAGS = flags("-u", "--unset", "-C", "--chdir", "-P", "-a", "--argv0")

/** `env [options] [NAME=value…] [cmd …]`, including the `-S`/`-iS'…'` split-string form that parses the rest as one shell string. */
const envRefusal = (args: ReadonlyArray<Word>, scope: Scope): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    if (word === undefined) break
    const text = word.text
    // A lone `-` is `-i`, not the command.
    if (text === "-") continue
    if (!text.startsWith("-")) {
      // Every word with an `=` before the command is an assignment, whatever its name; the first without one is the command.
      if (!text.includes("=")) return checkCommand(args.slice(i), scope)
      const reason = assignmentRefusal(word)
      if (reason !== undefined) return reason
      continue
    }
    // -S / --split-string / a short-flag cluster containing S: the remaining text is one shell string.
    const cluster = !text.startsWith("--") && /^-[a-zA-Z]*S/.test(text)
    if (text === "-S" || text === "--split-string" || text.startsWith("--split-string=") || cluster) {
      if (word.dynamic) return REASONS.dynamic
      const head = text.startsWith("--split-string=") ? text.slice("--split-string=".length) : cluster ? text.replace(/^-[a-zA-Z]*S/, "") : undefined
      const parts = head === undefined ? args.slice(i + 1) : [{ ...word, text: head }, ...args.slice(i + 1)]
      if (parts.some((part) => part.dynamic)) return REASONS.dynamic
      return nested(parts.map((part) => part.text).join(" "), scope)
    }
    if (ENV_VALUE_FLAGS.has(text)) i++
  }
  return undefined
}

/** `ps` flags that dump a process's environment: `--environment`, `-E`/`-wwE` in a single-dash cluster, or the BSD `e` in a no-dash cluster (`eww`, `auxe`). `-e`/`-ef` lists all processes, which is fine. */
const isPsEnvDump = (text: string): boolean =>
  text === "--environment" || (!text.startsWith("--") && text.startsWith("-") && /E/.test(text)) || (!text.startsWith("-") && /^[a-z]*e[a-z]*$/i.test(text))

const commandRefusal = (name: string, head: Word, args: ReadonlyArray<Word>, scope: Scope): string | undefined => {
  if (name === "sudo" || name === "su" || name === "doas") return REASONS.privilege
  if (CLUSTER.has(name)) return REASONS.cluster
  if (GCP.has(name)) return REASONS.gcp
  if (name === "op") return REASONS.secrets
  if (name === "security" && args.some((arg) => /^(find-(generic|internet)-password|dump-keychain|export)$/.test(arg.text))) return REASONS.secrets
  // `ps eww`/`ps -E` dumps a process's initial environment: in development the daemon still carries its tokens there (the kernel's envp copy survives the delete). The env dump is never needed for the task. (`-e`/`-ef` is the all-processes flag, not the environment one.)
  if (name === "ps" && args.some((arg) => isPsEnvDump(arg.text))) return REASONS.secrets
  if (name === "cat" && args.some((arg) => /\/proc\/[^/]+\/environ\b/.test(arg.text))) return REASONS.secrets
  if (name === "cast" && (args[0]?.text === "send" || args[0]?.text === "publish")) return REASONS.transaction
  if (name === "prisma" && (args[0]?.text === "migrate" || (args[0]?.text === "db" && args[1]?.text === "push"))) return REASONS.migration
  if (name === "bun" || name === "npm" || name === "pnpm" || name === "yarn") return packageManagerRefusal(name, args, scope)
  if (NETWORK.has(name)) return networkRefusal(name, args, scope)
  if (name === "gh") return ghRefusal(args)
  if (name === "git") return gitRefusal(args, scope.branch)
  if (name === "eval") {
    const text = literal(args)
    return text === undefined ? REASONS.dynamic : nested(text, scope)
  }
  // `trap 'cmd' SIGNAL` runs its first argument as a command when the signal fires.
  if (name === "trap") return args[0] === undefined ? undefined : checkString(args[0], scope)
  // `let` evaluates its arguments as arithmetic, which runs any `$(…)` inside, even quoted (`let 'a[$(…)]'`).
  if (name === "let" && args.some(substitutes)) return REASONS.dynamic
  if (DECLARATIONS.has(name)) return declarationRefusal(name, args)
  if (SHELLS.has(name)) return shellRefusal(args, scope)
  if (name === "source" || name === ".") return args[0] === undefined ? undefined : scriptRefusal(args[0], scope, true)
  if (name === "watch") {
    const text = literal(args.slice(firstPositional(args, flags("-n", "--interval", "-q", "--equexit"))))
    return text === undefined ? REASONS.dynamic : nested(text, scope)
  }
  if (name === "find") return findRefusal(args, scope)
  // An alias could run a refused command under another name, and the parser does not expand it; defining one is refused outright.
  if (name === "alias") return args.some((arg) => arg.text.includes("=")) ? REASONS.alias : undefined
  // A path to something not refused by name: a script runs whatever it contains.
  if (head.text.includes("/")) return scriptRefusal(head, scope, false)
  return undefined
}

const PM_GLOBAL_FLAGS = flags("--cwd", "-C", "--dir", "--filter", "-F", "--prefix", "-w", "--workspace", "--config")
const PM_SHELL_FLAGS = new Set(["-c", "--call", "--shell-mode"])

const packageManagerRefusal = (name: string, args: ReadonlyArray<Word>, scope: Scope): string | undefined => {
  const start = firstPositional(args, PM_GLOBAL_FLAGS)
  const [sub, ...rest] = args.slice(start)
  if (sub === undefined) return undefined
  // `bun exec '<string>'` runs a shell string, not a package.
  if (name === "bun" && sub.text === "exec") {
    const str = rest.find((arg) => !arg.text.startsWith("-"))
    return str === undefined ? undefined : str.dynamic ? REASONS.dynamic : nested(str.text, scope)
  }
  // `bun x`, `pnpm dlx`, `npm exec`: another command runs, or `-c '<string>'` runs a shell string.
  if (["x", "exec", "dlx"].includes(sub.text)) {
    const shellAt = rest.findIndex((arg) => PM_SHELL_FLAGS.has(arg.text) || arg.text.startsWith("--call="))
    if (shellAt !== -1) {
      const flag = rest[shellAt]
      const str = flag?.text.startsWith("--call=") ? { ...flag, text: flag.text.slice("--call=".length) } : rest[shellAt + 1]
      return str === undefined ? undefined : str.dynamic ? REASONS.dynamic : nested(str.text, scope)
    }
    const inner = rest.slice(firstPositional(rest, flags("-p", "--package")))
    return inner.length === 0 ? undefined : checkCommand(inner, scope)
  }
  // `run <name>` / `run-script <name>`: the script name is the first positional, past run's own flags (`--filter api`).
  const script = sub.text === "run" || sub.text === "run-script" ? rest.slice(firstPositional(rest, PM_GLOBAL_FLAGS))[0]?.text : sub.text
  return script !== undefined && /^(migrate|db:push|db:migrate)\b/.test(script) ? REASONS.migration : undefined
}

/** Hosts a request must never reach: internal prod routes, Slack, and the daemon's own API. Used for network commands and for the WebFetch tool's URL. */
export const hostRefusal = (text: string, daemonPort: number): string | undefined => {
  if (/\.internal\.merkl\.xyz/i.test(text)) return REASONS.internal
  if (SLACK_HOST.test(text)) return REASONS.slack
  if (new RegExp(`:${daemonPort}(?![0-9])`).test(text)) return REASONS.daemon
  return undefined
}

const networkRefusal = (name: string, args: ReadonlyArray<Word>, scope: Scope): string | undefined => {
  // A computed argument could expand to anything on the line, so the whole line is checked.
  const texts = args.some((arg) => arg.dynamic) ? [...args.map((arg) => arg.text), scope.source] : args.map((arg) => arg.text)
  for (const text of texts) {
    const reason = hostRefusal(text, scope.daemonPort)
    if (reason !== undefined) return reason
  }
  if (PORT_ARGUMENT.has(name) && args.some((arg) => arg.text === String(scope.daemonPort))) return REASONS.daemon
  return githubApiWriteRefusal(name, args)
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

/** `find … -exec cmd {} ;` runs `cmd` with `{}` replaced by each found path, so `{}` is a runtime value. */
const findRefusal = (args: ReadonlyArray<Word>, scope: Scope): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i]?.text ?? "")) continue
    const end = args.findIndex((arg, j) => j > i && (arg.text === ";" || arg.text === "+"))
    const inner = args.slice(i + 1, end === -1 ? undefined : end).map((word) => (word.text.includes("{}") ? { ...word, dynamic: true } : word))
    const reason = checkCommand(inner, scope)
    if (reason !== undefined) return reason
  }
  return undefined
}

/** Interpreters whose scripts the guard cannot read as shell. A shebang naming one (`#!/usr/bin/env bun`) means the file is not checked; anything else, `#!/usr/bin/env -S bash` included, is treated as shell. */
const NON_SHELL_INTERPRETER = /\b(node|bun|deno|ts-node|tsx|python[0-9.]*|ruby|perl|php|osascript|Rscript|elixir|escript)\b/

/**
 * A script runs whatever it contains, so its content goes through the same
 * guard. `bash x.sh` and `source x.sh` are always shell; a file executed by path
 * is checked as shell unless its shebang names another interpreter or it is
 * binary, which are beyond what a command-line check can see.
 */
const scriptRefusal = (path: Word, scope: Scope, shell: boolean): string | undefined => {
  if (path.dynamic) return REASONS.dynamic
  const expanded = expandHome(path.text)
  if (!isAbsolute(expanded) && !scope.cwdKnown) return `Bridgetown cannot tell which ${path.text} this runs. Use a path from your worktree.`
  const content = scope.readFile(isAbsolute(expanded) ? expanded : resolve(scope.cwd, expanded))
  if (content === undefined) return `Bridgetown could not read ${path.text} to check what it runs.`
  const head = content.slice(0, 4_096)
  const shebang = head.startsWith("#!") ? head.slice(0, head.indexOf("\n") === -1 ? undefined : head.indexOf("\n")) : ""
  if (!shell && (head.includes("\u0000") || NON_SHELL_INTERPRETER.test(shebang))) return undefined
  const reason = nested(content, scope)
  return reason === undefined ? undefined : `${path.text} runs a refused command. ${reason}`
}

/** The `command` a tool would run, when it has one (Bash, or any other tool that takes a shell command). */
export const commandOf = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null || !("command" in input)) return undefined
  return typeof input.command === "string" ? input.command : undefined
}
