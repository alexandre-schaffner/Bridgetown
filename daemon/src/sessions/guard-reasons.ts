import type { Word } from "./shell.ts"

/** What the agent is told when the guard refuses, with what to do instead. */
export const REASONS = {
  merge: "Merging is a human gate. Finish with outcome fix_pr; Bridgetown asks the user to merge once CI is green.",
  rerun:
    "Re-running or cancelling a run touches the production pipeline. Finish with outcome recommendation and recommendation rerun_failed_jobs; the user re-runs it with one click.",
  watch:
    "Don't wait for CI: it holds your slot and keeps the user's messages from reaching you. Push, then finish with the structured result; Bridgetown watches the checks and sends you back with the failing logs if one goes red.",
  workflow: "Dispatching workflows is a human action. Describe it in your recommendation instead.",
  release: "Releases are cut by the user from Bridgetown after merge. Set releasePrefix in your final output instead.",
  tag: "Tags trigger deploys. Never create or move tags.",
  pushRefs: "Tags trigger deploys. Never push tags or every ref.",
  force: "Force pushes are not allowed. Add a new commit instead.",
  deleteRemote: "Deleting remote branches is not allowed.",
  apiWrite: "Write calls to the GitHub API are not allowed from Bridgetown sessions. Use `gh pr create` / `gh pr comment` for your own pull request.",
  graphql: "GraphQL mutations are not allowed from Bridgetown sessions.",
  ghCommand:
    "Only read-only `gh` commands and your own PR's create/comment/edit are allowed (pr, run, workflow, issue, repo, search views; `gh api` GETs). Describe anything else in your result.",
  gitExec: "This git command runs an arbitrary command (rebase --exec, submodule foreach, filter-branch, difftool -x, bisect run). Run the command directly so it can be checked.",
  gitConfig: "Setting this git config could run a command or push a tag on a later git call. It is not allowed.",
  credential: "Reading git credentials is not allowed. If a credential is missing, call the ask tool.",
  review: "Reviews and PR state changes are the user's call.",
  draft:
    "Open the pull request as a draft (`gh pr create --draft`). An independent review checks every pushed fix; Bridgetown takes the PR out of draft once it passes.",
  alias: "Aliases could run a refused command under another name. Run the command itself.",
  cluster: "Cluster access is not allowed. Read logs through the grafana MCP and describe any cluster action in your recommendation.",
  gcp: "GCP access is not allowed from automated sessions (prod safety hard rule).",
  secrets: "Reading secrets is not allowed. If a credential is missing, call the ask tool.",
  migration: "Migrations touch databases. Describe the migration in the PR instead.",
  internal: "Internal routes are production. Use the merkl or grafana MCP for read-only data (prod safety hard rule).",
  slack: "Slack is reached through Bridgetown only. Use the slack_context tool to read, and put what should be said in your final summary.",
  daemon: "The Bridgetown API belongs to the user, not to sessions.",
  transaction: "Sending transactions is never allowed.",
  privilege: "Privilege escalation is not allowed.",
  dynamic: "Run commands by name, not through a variable, substitution or glob, so they can be checked.",
  computedFlag:
    'A computed word here could become one of the flags Bridgetown checks. Write flags out, and quote a computed value (`--body "$BODY"`) so it stays one word.',
  pipeToShell: "Piping commands into a shell is not allowed. Run the commands directly.",
  dangerousEnv: "That environment variable would make a later command run something the guard cannot see. Run the command directly.",
  nesting: "Too many nested shells to check. Run the commands directly.",
} as const

/**
 * Options before the first positional, skipping the values of `withValue`
 * options. Returns the index of the first positional (or `--` + 1).
 */
export const firstPositional = (args: ReadonlyArray<Word>, withValue: ReadonlySet<string>): number => {
  for (let i = 0; i < args.length; i++) {
    const text = args[i]?.text ?? ""
    if (text === "--") return i + 1
    if (!text.startsWith("-") || text === "-") return i
    if (withValue.has(text)) i++
  }
  return args.length
}

export const flags = (...names: ReadonlyArray<string>): ReadonlySet<string> => new Set(names)

/** Programs that run nothing else, and git's "no hooks" path. */
const INERT = new Set(["", ":", "true", "false", "cat", "less", "more", "/dev/null"])

/**
 * A command-valued setting (an editor, pager, ssh or hook path, from a variable or
 * git config) that runs nothing: empty, or an inert program with only its own flags.
 * `GIT_EDITOR=true git rebase --continue` and the Claude CLI's own
 * `git -c core.pager= -c core.hooksPath=/dev/null` turn a command off, not on.
 */
export const runsNothing = (value: string): boolean => {
  const [program = "", ...rest] = value.trim().split(/\s+/)
  return INERT.has(program) && rest.every((word) => word.startsWith("-"))
}
