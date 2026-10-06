import { GH_HOST } from "../config.ts"
import { isOwnBranch } from "../domain/session.ts"
import { escapeRegExp } from "../lib/text.ts"
import { flags, REASONS } from "./guard-reasons.ts"
import type { Word } from "./shell.ts"

/**
 * `gh` and `git`. `gh` is an allowlist of read-only commands plus the session's
 * own pull request; `git` refuses merges' remote effects (pushes to anything but
 * the session branch, tags, force pushes), command-running subcommands and
 * config that would run a command or push a tag on a later call.
 */

const GH_API_VALUE_FLAGS = flags("-H", "--header", "-q", "--jq", "-t", "--template", "--hostname", "-p", "--preview", "--cache")
const GH_API_FIELD_FLAGS = flags("-f", "-F", "--field", "--raw-field", "--input")
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])
/** Flags that may sit between `gh`, the group and the sub-command (`gh pr -R o/r merge`), whose value is not a positional. */
const GH_VALUE_FLAGS = flags("-R", "--repo", "--hostname")

/** The first two non-flag words (group and sub-command), skipping the values of flags that take one. A dynamic one means the command cannot be identified. */
const ghPositionals = (args: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  const positional: Array<Word> = []
  for (let i = 0; i < args.length && positional.length < 2; i++) {
    const word = args[i]
    if (word === undefined) break
    if (GH_VALUE_FLAGS.has(word.text)) i++
    else if (!word.text.startsWith("-")) positional.push(word)
  }
  return positional
}

export const ghRefusal = (args: ReadonlyArray<Word>): string | undefined => {
  const positional = ghPositionals(args)
  const [group, sub] = positional
  if (positional.some((word) => word.dynamic)) return REASONS.dynamic
  const has = (flag: string) => args.some((arg) => arg.text === flag || arg.text.startsWith(`${flag}=`))
  switch (group?.text) {
    case "pr":
      switch (sub?.text) {
        case "view":
        case "list":
        case "diff":
        case "status":
        case "checkout":
        case "comment":
          return undefined
        case "checks":
          return has("--watch") || has("-w") ? REASONS.watch : undefined
        case "create":
          return prCreateRefusal(args)
        case "edit":
          return has("--add-reviewer") || has("--base") || has("-B") ? REASONS.review : undefined
        default:
          return sub?.text === "merge" ? REASONS.merge : REASONS.ghCommand
      }
    case "run":
      return sub?.text === "view" || sub?.text === "list" || sub?.text === "download" ? undefined : REASONS.ghCommand
    case "workflow":
      return sub?.text === "view" || sub?.text === "list" ? undefined : REASONS.ghCommand
    case "issue":
      return sub?.text === "view" || sub?.text === "list" ? undefined : REASONS.ghCommand
    case "repo":
      return sub?.text === "view" ? undefined : REASONS.ghCommand
    case "search":
      return undefined
    case "auth":
      // The token itself must stay out of reach; status may reveal it with these flags.
      return sub?.text === "status" && !has("-t") && !has("--show-token") ? undefined : REASONS.ghCommand
    case "api":
      return ghApiRefusal(args.slice(args.findIndex((arg) => arg === group) + 1))
    default:
      return REASONS.ghCommand
  }
}

/** `gh pr create` options whose value is the next word: `--body --draft` sets the body, not the draft. */
const PR_CREATE_VALUE_FLAGS = flags(
  ...["-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-H", "--head", "-a", "--assignee", "-l", "--label"],
  ...["-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template", "-R", "--repo", "--recover"],
)

/** `gh pr create` must open a draft against `main`: an independent review gates every pushed fix before it is readied. */
const prCreateRefusal = (args: ReadonlyArray<Word>): string | undefined => {
  // gh takes the last occurrence, so any `=false` may win over a bare `--draft`.
  const drafts = draftFlags(args)
  return drafts.length === 0 || drafts.some((flag) => !["--draft", "-d", "--draft=true", "-d=true"].includes(flag)) ? REASONS.draft : undefined
}

/** Every draft flag `gh pr create` will read, combined boolean shorthands (`-dw`) included. */
const draftFlags = (args: ReadonlyArray<Word>): ReadonlyArray<string> => {
  const found: Array<string> = []
  for (let i = 0; i < args.length; i++) {
    const text = args[i]?.text ?? ""
    if (PR_CREATE_VALUE_FLAGS.has(text)) i++
    else if (/^(--draft|-d)(=|$)/.test(text)) found.push(text)
    else if (/^-[dfw]{2,}$/.test(text) && text.includes("d")) found.push("-d")
  }
  return found
}

const ghApiRefusal = (args: ReadonlyArray<Word>): string | undefined => {
  let method: string | undefined
  let fields = false
  let endpoint: string | undefined
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    const text = word?.text ?? ""
    const next = args[i + 1]
    if (text === "-X" || text === "--method") {
      if (next?.dynamic) return REASONS.dynamic
      method = next?.text.toUpperCase()
      i++
    } else if (text.startsWith("--method=")) {
      if (word?.dynamic) return REASONS.dynamic
      method = text.slice("--method=".length).toUpperCase()
    } else if (/^-X./.test(text)) {
      if (word?.dynamic) return REASONS.dynamic
      method = text.slice(2).toUpperCase()
    } else if (GH_API_FIELD_FLAGS.has(text)) {
      fields = true
      i++
    } else if (/^(--field|--raw-field|--input)=/.test(text) || /^-[fF]./.test(text)) {
      fields = true
    } else if (GH_API_VALUE_FLAGS.has(text)) {
      i++
    } else if (!text.startsWith("-") && !word?.dynamic && endpoint === undefined) {
      endpoint = text
    } else if (word?.dynamic) {
      // A dynamic word undergoes word-splitting and could introduce -X/-f/--input, turning a read into a write (`gh api …/merge $X`). It cannot be checked, so it is refused. The value of a known value flag is consumed above and never reaches here.
      return REASONS.dynamic
    }
  }
  if (endpoint === "graphql" && args.some((arg) => /\bmutation\b/i.test(arg.text))) return REASONS.graphql
  if (method !== undefined && WRITE_METHODS.has(method)) return REASONS.apiWrite
  if (fields && method !== "GET") return REASONS.apiWrite
  return undefined
}

/** A `curl`/`wget` write to the GitHub API (any host carrying its path), e.g. with a token from `gh auth token`, is as much an API write as `gh api`. */
export const githubApiWriteRefusal = (args: ReadonlyArray<Word>): string | undefined => {
  const line = args.map((arg) => arg.text).join(" ")
  const ghApi = new RegExp(`(api\\.github\\.com|${escapeRegExp(GH_HOST)}/api)`, "i").test(line)
  if (!ghApi) return undefined
  const writes = args.some((arg) => {
    const t = arg.text
    if (t === "-X" || t === "--request") return true
    if (/^-X[A-Za-z]/.test(t)) return WRITE_METHODS.has(t.slice(2).toUpperCase())
    if (/^--request=(POST|PUT|PATCH|DELETE)$/i.test(t)) return true
    return ["-d", "--data", "-F", "--form", "-T", "--upload-file"].includes(t) || /^(--data|-d)[=@]/.test(t) || /^--form=/.test(t)
  })
  return writes ? REASONS.apiWrite : undefined
}

const GIT_VALUE_OPTIONS = flags("-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source")

const explicitPush = (branch: string) => `Push only your own branch, explicitly: git push -u origin ${branch}`

/** Config keys that, once set, could run a command or push a tag on a later git call. */
const forbiddenConfig = (key: string): boolean =>
  /^(alias\.|push\.(followtags|default)|remote\..+\.(push|mirror|pushurl)|core\.(sshcommand|pager|fsmonitor|editor|hookspath)|pager\.|sequence\.editor|diff\.external|credential\.(helper|.*\.helper))/i.test(
    key.trim(),
  )

/** The `key` of a `-c key=value`, `--config-env=key=env` or bare config word, or `undefined` when it is dynamic. */
const configKey = (word: Word | undefined): string | undefined => {
  if (word === undefined) return undefined
  if (word.dynamic) return ""
  return word.text.replace(/^--config-env=/, "").split("=")[0]
}

export const gitRefusal = (args: ReadonlyArray<Word>, branch: string): string | undefined => {
  let at = 0
  for (; at < args.length; at++) {
    const option = args[at]
    if (option === undefined || !option.text.startsWith("-")) break
    if (option.text === "-c" || option.text === "--config-env") {
      if (forbiddenConfig(configKey(args[at + 1]) ?? "")) return REASONS.gitConfig
      at++
    } else if (option.text.startsWith("-c=") || option.text.startsWith("--config-env=")) {
      if (forbiddenConfig(configKey(option) ?? "")) return REASONS.gitConfig
    } else if (GIT_VALUE_OPTIONS.has(option.text)) at++
  }
  const sub = args[at]
  if (sub === undefined) return undefined
  if (sub.dynamic) return REASONS.dynamic
  const rest = args.slice(at + 1)
  switch (sub.text) {
    case "push":
      return pushRefusal(rest, branch)
    case "send-pack":
    case "http-push":
    case "p4":
    case "svn":
      return explicitPush(branch)
    case "subtree":
      return rest.some((arg) => arg.text === "push") ? explicitPush(branch) : undefined
    case "tag":
      return tagRefusal(rest)
    case "mktag":
      return REASONS.tag
    case "update-ref":
      return rest.some((arg) => arg.text.startsWith("refs/tags/")) ? REASONS.tag : undefined
    case "credential":
      return REASONS.credential
    case "rebase":
      return rest.some((arg) => arg.text === "-x" || arg.text === "--exec" || arg.text.startsWith("--exec=")) ? REASONS.gitExec : undefined
    case "submodule":
      return rest[0]?.text === "foreach" ? REASONS.gitExec : undefined
    case "bisect":
      return rest[0]?.text === "run" ? REASONS.gitExec : undefined
    case "difftool":
      return rest.some((arg) => arg.text === "-x" || arg.text === "--extcmd" || arg.text.startsWith("--extcmd=")) ? REASONS.gitExec : undefined
    case "filter-branch":
      return REASONS.gitExec
    case "config":
      return configRefusal(rest)
    default:
      return undefined
  }
}

/** `git config` may read freely; it may not write a key that could run a command or push a tag later. */
const configRefusal = (args: ReadonlyArray<Word>): string | undefined => {
  const reading = args.some((arg) => ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "-l", "--list"].includes(arg.text))
  if (reading) return undefined
  const key = args.find((arg) => !arg.text.startsWith("-"))
  if (key?.dynamic) return REASONS.gitConfig
  return key !== undefined && forbiddenConfig(key.text) ? REASONS.gitConfig : undefined
}

const PUSH_REF_FLAGS = flags("--tags", "--follow-tags", "--mirror", "--all", "--branches")
const PUSH_FORCE_FLAGS = flags("--force", "--force-with-lease", "--force-if-includes")
const PUSH_DELETE_FLAGS = flags("--delete", "--prune")
const PUSH_FLAGS_WITH_VALUE = flags("--repo", "--receive-pack", "--exec", "-o", "--push-option", "--signed")

/**
 * Every refspec destination of `git push <remote> <refspec…>` must be the
 * session's branch (or a follow-up `<branch>-N`), and the remote must be
 * `origin`. No refspec at all pushes whatever is checked out, which is refused
 * so the target is always explicit.
 */
const pushRefusal = (args: ReadonlyArray<Word>, branch: string): string | undefined => {
  const positional: Array<Word> = []
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    if (word === undefined) break
    const text = word.text
    if (text === "--") {
      positional.push(...args.slice(i + 1))
      break
    }
    if (text.startsWith("--")) {
      const name = text.split("=")[0] ?? text
      if (PUSH_REF_FLAGS.has(name)) return REASONS.pushRefs
      if (PUSH_FORCE_FLAGS.has(name)) return REASONS.force
      if (PUSH_DELETE_FLAGS.has(name)) return REASONS.deleteRemote
      if (PUSH_FLAGS_WITH_VALUE.has(name) && !text.includes("=")) i++
      continue
    }
    if (text.startsWith("-") && text.length > 1) {
      if (text.slice(1).includes("f")) return REASONS.force
      if (text.slice(1).includes("d")) return REASONS.deleteRemote
      if (PUSH_FLAGS_WITH_VALUE.has(text)) i++
      continue
    }
    positional.push(word)
  }
  const own = (ref: string) => isOwnBranch(branch, ref.replace(/^refs\/heads\//, ""))
  const explicit = explicitPush(branch)
  const [remote, ...refspecs] = positional
  if (remote === undefined || remote.dynamic || remote.text !== "origin") return explicit
  if (refspecs.length === 0) return explicit
  for (const spec of refspecs) {
    if (spec.text.startsWith("+")) return REASONS.force
    if (spec.text.startsWith(":")) return REASONS.deleteRemote
    if (spec.dynamic || !own(spec.text.includes(":") ? (spec.text.split(":")[1] ?? "") : spec.text)) return explicit
  }
  return undefined
}

/** Value flags of `git tag` whose next word is a commit/key, not a tag name. */
const TAG_VALUE_FLAGS = flags("--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "--sort", "--format")
/** Flags that put `git tag` in create, delete or edit mode. */
const TAG_WRITE_FLAGS = flags("-a", "--annotate", "-s", "--sign", "-u", "--local-user", "-m", "--message", "-F", "--file", "-f", "--force", "-d", "--delete", "-e", "--edit", "--create-reflog")

/** `git tag` may only list: no tag-name positional and no create/delete flag. `git tag --sort=x NAME` creates NAME. */
const tagRefusal = (args: ReadonlyArray<Word>): string | undefined => {
  const listing = args.some((arg) => arg.text === "-l" || arg.text === "--list" || /^-n[0-9]*$/.test(arg.text))
  const positional: Array<Word> = []
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    if (word === undefined) break
    const text = word.text
    if (text === "--") {
      positional.push(...args.slice(i + 1))
      break
    }
    const name = text.split("=")[0] ?? text
    if (TAG_WRITE_FLAGS.has(name) && (name.startsWith("--") || /^-[a-zA-Z]$/.test(name))) return REASONS.tag
    if (/^-[a-zA-Z]{2,}$/.test(text) && [...text.slice(1)].some((c) => TAG_WRITE_FLAGS.has(`-${c}`))) return REASONS.tag
    if (TAG_VALUE_FLAGS.has(name) && !text.includes("=")) i++
    else if (!text.startsWith("-")) positional.push(word)
  }
  if (listing) return undefined
  return positional.length === 0 ? undefined : REASONS.tag
}
