import { flags, REASONS } from "./guard-reasons.ts"
import type { Word } from "./shell.ts"

/** `gh` and `git`: merges, reruns, releases, API writes, tags, force pushes and pushes to anything but the session's branch. */

const GH_API_VALUE_FLAGS = flags("-H", "--header", "-q", "--jq", "-t", "--template", "--hostname", "-p", "--preview", "--cache")
const GH_API_FIELD_FLAGS = flags("-f", "-F", "--field", "--raw-field", "--input")
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])
/** Flags that may sit between `gh`, the group and the sub-command (`gh pr -R o/r merge`), whose value is not a positional. */
const GH_VALUE_FLAGS = flags("-R", "--repo", "--hostname")

export const ghRefusal = (args: ReadonlyArray<Word>): string | undefined => {
  const positional: Array<string> = []
  for (let i = 0; i < args.length && positional.length < 2; i++) {
    const text = args[i]?.text ?? ""
    if (GH_VALUE_FLAGS.has(text)) i++
    else if (!text.startsWith("-")) positional.push(text)
  }
  const [group, sub] = positional
  const has = (flag: string) => args.some((arg) => arg.text === flag || arg.text.startsWith(`${flag}=`))
  switch (group) {
    case "pr":
      if (sub === "merge") return REASONS.merge
      if (sub === "review" || sub === "close" || sub === "reopen") return REASONS.review
      if (sub === "ready") return has("--undo") ? REASONS.review : REASONS.draft
      if (sub === "create") {
        // gh takes the last occurrence, so any `=false` may win over a bare `--draft`.
        const drafts = draftFlags(args)
        if (drafts.length === 0 || drafts.some((flag) => !["--draft", "-d", "--draft=true", "-d=true"].includes(flag))) return REASONS.draft
      }
      if (sub === "edit" && has("--add-reviewer")) return REASONS.review
      if (sub === "checks" && (has("--watch") || has("-w"))) return REASONS.watch
      return undefined
    case "run":
      if (sub === "watch") return REASONS.watch
      return sub === "rerun" || sub === "cancel" ? REASONS.rerun : undefined
    case "workflow":
      return sub === "run" || sub === "enable" || sub === "disable" ? REASONS.workflow : undefined
    case "release":
      return REASONS.release
    case "alias":
      return sub === "set" || sub === "import" ? REASONS.alias : undefined
    case "api":
      return ghApiRefusal(args.slice(args.findIndex((arg) => arg.text === "api") + 1))
    default:
      return undefined
  }
}

/** `gh pr create` options whose value is the next word: `--body --draft` sets the body, not the draft. */
const PR_CREATE_VALUE_FLAGS = flags(
  ...["-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-H", "--head", "-a", "--assignee", "-l", "--label"],
  ...["-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template", "-R", "--repo", "--recover"],
)

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
    const text = args[i]?.text ?? ""
    const next = args[i + 1]?.text ?? ""
    if (text === "-X" || text === "--method") {
      method = next.toUpperCase()
      i++
    } else if (text.startsWith("--method=")) {
      method = text.slice("--method=".length).toUpperCase()
    } else if (/^-X./.test(text)) {
      method = text.slice(2).toUpperCase()
    } else if (GH_API_FIELD_FLAGS.has(text)) {
      fields = true
      i++
    } else if (/^(--field|--raw-field|--input)=/.test(text) || /^-[fF]./.test(text)) {
      fields = true
    } else if (GH_API_VALUE_FLAGS.has(text)) {
      i++
    } else if (!text.startsWith("-") && endpoint === undefined) {
      endpoint = text
    }
  }
  if (endpoint === "graphql" && args.some((arg) => /\bmutation\b/i.test(arg.text))) return REASONS.graphql
  if (method !== undefined && WRITE_METHODS.has(method)) return REASONS.apiWrite
  if (fields && method !== "GET") return REASONS.apiWrite
  return undefined
}

const GIT_VALUE_OPTIONS = flags("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source")
const explicitPush = (branch: string) => `Push only your own branch, explicitly: git push -u origin ${branch}`
const isAliasConfig = (word: Word | undefined): boolean => word !== undefined && (word.dynamic || /^alias\./i.test(word.text.replace(/^--config-env=/, "")))

export const gitRefusal = (args: ReadonlyArray<Word>, branch: string): string | undefined => {
  let at = 0
  for (; at < args.length; at++) {
    const option = args[at]
    if (option === undefined || !option.text.startsWith("-")) break
    if ((option.text === "-c" || option.text === "--config-env") && isAliasConfig(args[at + 1])) return REASONS.alias
    if (option.text.startsWith("--config-env=") && isAliasConfig(option)) return REASONS.alias
    if (GIT_VALUE_OPTIONS.has(option.text)) at++
  }
  const sub = args[at]
  if (sub === undefined) return undefined
  if (sub.dynamic) return REASONS.dynamic
  const rest = args.slice(at + 1)
  switch (sub.text) {
    case "push":
      return pushRefusal(rest, branch)
    case "send-pack":
      return explicitPush(branch)
    case "tag":
      return tagRefusal(rest)
    case "config": {
      const reading = rest.some((arg) => ["--get", "--get-all", "--get-regexp", "-l", "--list"].includes(arg.text))
      return !reading && rest.some((arg) => isAliasConfig(arg)) ? REASONS.alias : undefined
    }
    default:
      return undefined
  }
}

const PUSH_REF_FLAGS = flags("--tags", "--follow-tags", "--mirror", "--all", "--branches")
const PUSH_FORCE_FLAGS = flags("--force", "--force-with-lease", "--force-if-includes")
const PUSH_DELETE_FLAGS = flags("--delete", "--prune")
const PUSH_FLAGS_WITH_VALUE = flags("--repo", "--receive-pack", "--exec", "-o", "--push-option", "--signed")

/**
 * Every refspec destination of `git push … <remote> <refspec…>` must be the
 * session's branch (or a follow-up `<branch>-N`). No refspec at all pushes
 * whatever is checked out, which is refused so the target is always explicit.
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
  const own = (ref: string) => {
    const name = ref.replace(/^refs\/heads\//, "")
    return name === branch || new RegExp(`^${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`).test(name)
  }
  const refspecs = positional.slice(1)
  const explicit = explicitPush(branch)
  if (refspecs.length === 0) return explicit
  for (const spec of refspecs) {
    if (spec.text.startsWith("+")) return REASONS.force
    if (spec.text.startsWith(":")) return REASONS.deleteRemote
    if (spec.dynamic || !own(spec.text.includes(":") ? (spec.text.split(":")[1] ?? "") : spec.text)) return explicit
  }
  return undefined
}

const TAG_LIST_FLAGS = flags("-l", "--list", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "--sort", "--format", "--column", "--no-column")

/** `git tag` may only list. */
const tagRefusal = (args: ReadonlyArray<Word>): string | undefined => {
  const listing = args.some((arg) => TAG_LIST_FLAGS.has(arg.text.split("=")[0] ?? "") || /^-n[0-9]*$/.test(arg.text))
  const creating = args.some((arg) => /^-[a-zA-Z]+$/.test(arg.text) && /[asufdmFe]/.test(arg.text.slice(1)) && !/^-n[0-9]*$/.test(arg.text))
    || args.some((arg) => /^--(annotate|sign|local-user|force|delete|message|file|edit|create-reflog)(=|$)/.test(arg.text))
  return listing && !creating ? undefined : REASONS.tag
}
