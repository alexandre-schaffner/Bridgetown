import { mkdtempSync, writeFileSync, realpathSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { Effect } from "effect"
import { GH_HOST, GHE_REPO } from "../config.ts"
import { isOwnBranch } from "../domain/session.ts"
import type { AgentRequest } from "../agent/protocol.ts"
import { changedPaths, type TreeEntry } from "./changes.ts"
import { checkCommand } from "./commands.ts"
import { DIFF_FLAGS, git, gitWithoutFilters, runOk, type RunOptions } from "../lib/proc.ts"
import { isSessionBranch } from "../sessions/worktree.ts"
import { ownPrUrl } from "../ship/pr.ts"
import type { BrokerRequest } from "./capabilities.ts"
import { observe } from "./observability.ts"
import { MAX_TOOL_BYTES, assertNoSecrets, evidence, protectedPath } from "./policy.ts"
import { runSandboxed } from "./sandbox.ts"
import { fileBroker, snapshotFiles } from "./files.ts"

/** Protected execution metadata may never ride along with a brokered fix. */
export const publishablePath = (path: string): boolean => !protectedPath(path) && !path.replaceAll("\\", "/").split("/").some((part, index, parts) => part === "workflows" && parts[index - 1] === ".github") && path !== ".gitattributes"

export const makeBroker = (request: AgentRequest, runCommand: (command: ReadonlyArray<string>, options: RunOptions) => Promise<string> = (command, options) => Effect.runPromise(runOk(command, options), { signal: request.abort.signal })): ((input: BrokerRequest) => Promise<string>) => {
  const { session, abort } = request
  const worktree = session.worktree
  let pending = Promise.resolve()
  const execute = (command: ReadonlyArray<string>, options: RunOptions = {}) => runCommand(command, { cwd: worktree ?? session.repoPath, env: { GH_HOST }, timeoutMs: 60_000, maxOutputBytes: MAX_TOOL_BYTES, ...options })
  const github = (...args: ReadonlyArray<string>) => execute(["gh", ...args, "--repo", `${GH_HOST}/${GHE_REPO}`])

  let activeBranch: string | undefined
  const prepareBranch = async (): Promise<void> => {
    if (activeBranch !== undefined) return
    if (worktree === null || !isSessionBranch(session.branch)) throw new Error("Worktree is not prepared.")
    let branch = (await execute(git("branch", "--show-current"))).trim()
    if (!isOwnBranch(session.branch, branch)) throw new Error("Worktree is not on an authorized session branch.")
    let mergedBranch = session.branch
    if (session.milestones.merged && branch !== session.branch && ownPrUrl(session.prUrl) !== null) {
      const previous = z.object({ headRefName: z.string() }).parse(JSON.parse(await github("pr", "view", session.prUrl ?? "", "--json", "headRefName")))
      mergedBranch = previous.headRefName
    }
    if (session.milestones.merged && branch === mergedBranch) {
      if ((await candidates()).paths.length !== 0) throw new Error("A merged worktree has local changes. Ask the user to take over.")
      await execute(git("fetch", "origin", "main"))
      const refs = await execute(git("for-each-ref", "--format=%(refname:short)", `refs/heads/${session.branch}-*`))
      const numbers = refs.split("\n").filter((name) => isOwnBranch(session.branch ?? "", name)).map((name) => Number(name.slice((session.branch ?? "").length + 1))).filter(Number.isFinite)
      branch = `${session.branch}-${Math.max(1, ...numbers) + 1}`
      const configKeys = await execute(git("config", "--null", "--list", "--name-only"))
      await execute(gitWithoutFilters(configKeys, ["switch", "-c", branch, "origin/main"]))
    }
    activeBranch = branch
  }

  const candidates = async () => {
    if (worktree === null) throw new Error("Worktree is not prepared.")
    const parent = (await execute(git("rev-parse", "HEAD"))).trim()
    const tree = await execute(git("ls-tree", "-r", "-z", parent), { maxOutputBytes: 4 * 1024 * 1024 })
    const added = await execute(git("ls-files", "--others", "--exclude-standard", "-z"), { maxOutputBytes: 4 * 1024 * 1024 })
    const entries: Array<TreeEntry> = tree.split("\0").filter(Boolean).map((row) => {
      const tab = row.indexOf("\t")
      const [mode, type, oid] = row.slice(0, tab).split(" ")
      if (tab < 0 || mode === undefined || type !== "blob" || oid === undefined) throw new Error("Unsupported Git tree entry; hand off this fix.")
      return { mode, oid, path: row.slice(tab + 1) }
    })
    entries.push(...added.split("\0").filter(Boolean).map((path) => ({ path, oid: null, mode: "100644" })))
    return { parent, paths: await changedPaths(worktree, entries, abort.signal) }
  }
  const capturePatch = async () => {
    if (worktree === null) throw new Error("Worktree is not prepared.")
    const { parent, paths } = await candidates()
    if (paths.some((path) => !publishablePath(path))) throw new Error("This fix changes protected configuration or credentials. Hand it to the user instead.")
    const snapshot = await snapshotFiles(worktree, paths, abort.signal)
    for (const file of snapshot) { assertNoSecrets(file.path); if (file.content !== null) assertNoSecrets(file.content) }
    const staging = mkdtempSync(join(tmpdir(), "bt-stage-"))
    try {
      const options = { env: { GH_HOST, GIT_INDEX_FILE: join(staging, "index") } }
      await execute(git("read-tree", parent), options)
      for (const file of snapshot) {
        if (file.content === null) await execute(git("update-index", "--force-remove", "--", file.path), options)
        else {
          const object = (await execute(git("hash-object", "-w", "--no-filters", "--stdin"), { ...options, stdin: file.content })).trim()
          await execute(git("update-index", "--add", "--cacheinfo", file.mode, object, file.path), options)
        }
      }
      const patch = await execute(git("diff", ...DIFF_FLAGS, "--cached", "--"), options)
      assertNoSecrets(patch)
      const tree = (await execute(git("write-tree"), options)).trim()
      return { parent, tree, patch }
    } finally { await rm(staging, { recursive: true, force: true }) }
  }

  const publish = async (args: Extract<BrokerRequest, { tool: "submit_fix" }>["args"]): Promise<string> => {
    if (worktree === null || !isSessionBranch(session.branch)) throw new Error("Only this session's prepared branch can be published.")
    assertNoSecrets(args.title); assertNoSecrets(args.body)
    if ((await execute(git("branch", "--show-current"))).trim() !== activeBranch) throw new Error("The worktree is no longer on this session's branch.")
    // Verify the worktree registration; replacing its .git file cannot redirect the trusted broker.
    const registered = await execute(git("worktree", "list", "--porcelain"), { cwd: session.repoPath })
    if (!registered.split("\n\n").some((entry) => entry.split("\n").includes(`branch refs/heads/${activeBranch}`) && entry.split("\n").some((line) => line.startsWith("worktree ") && realpathSync(line.slice(9)) === realpathSync(worktree)))) throw new Error("Worktree registration does not match this session.")
    const { parent, tree, patch } = await capturePatch()
    let publishedHead = parent
    if (patch !== "") {
      publishedHead = (await execute(git("-c", "commit.gpgsign=false", "commit-tree", tree, "-p", parent, "-m", args.title))).trim()
      await execute(git("update-ref", `refs/heads/${activeBranch}`, publishedHead, parent))
      await execute(git("read-tree", publishedHead))
    }
    const existing = z.array(z.object({ url: z.string(), headRefName: z.string(), isDraft: z.boolean() })).parse(JSON.parse(await github("pr", "list", "--head", activeBranch ?? "", "--state", "open", "--json", "url,headRefName,isDraft")))
    if (existing.length > 1) throw new Error("Multiple PRs match this branch. Ask the user to take over.")
    const previous = existing[0]
    const url = previous === undefined ? null : ownPrUrl(previous.url)
    if (previous !== undefined && (url === null || previous.headRefName !== activeBranch)) throw new Error("Existing PR does not match this session's authorized branch.")
    // Withdraw readiness before moving a previously reviewed PR's head.
    if (previous !== undefined && !previous.isDraft && url !== null) await github("pr", "ready", url, "--undo")
    // Never trust the repo's configured origin to choose where data is sent; push the exact snapshot commit.
    await execute(git("push", `https://${GH_HOST}/${GHE_REPO}.git`, `${publishedHead}:refs/heads/${activeBranch}`))
    const scratch = mkdtempSync(join(tmpdir(), "bt-pr-"))
    try {
      const body = join(scratch, "body.md")
      writeFileSync(body, args.body, { mode: 0o600 })
      if (url !== null) {
        await github("pr", "edit", url, "--title", args.title, "--body-file", body)
        return url
      }
      const created = ownPrUrl((await github("pr", "create", "--draft", "--base", "main", "--head", activeBranch ?? "", "--title", args.title, "--body-file", body)).trim())
      if (created === null) throw new Error("GitHub did not return a PR in the authorized repository.")
      return created
    } finally { await rm(scratch, { recursive: true, force: true }) }
  }

  const invoke = async (input: BrokerRequest): Promise<string> => {
    if (abort.signal.aborted) throw new Error("Investigation interrupted.")
    if (worktree === null) throw new Error("The investigation worktree is not ready.")
    await prepareBranch()
    switch (input.tool) {
      case "run": {
        assertNoSecrets(input.args.command)
        const reason = await checkCommand(worktree, input.args.command, activeBranch ?? "", request.daemonPort, abort.signal)
        if (reason !== undefined) { request.onRefused(input.args.command, reason); throw new Error(reason) }
        const result = await runSandboxed(worktree, input.args.command, abort.signal)
        return evidence(`Sandbox exit ${result.exitCode}`, `${result.stdout}${result.stderr}`)
      }
      case "read_file":
      case "list_files": return fileBroker(worktree, input, abort.signal)
      case "write_file": {
        if (!publishablePath(input.args.path)) throw new Error("This path is protected.")
        return fileBroker(worktree, input, abort.signal)
      }
      case "github": {
        const { operation, number, path } = input.args
        if (operation === "local_diff") return evidence("Local diff", (await capturePatch()).patch)
        if (operation === "history" || operation === "blame") {
          if (path === undefined || protectedPath(path) || path.includes("\0") || path.split(/[\\/]/).includes("..") || path.startsWith("/")) throw new Error("History needs a relative source path.")
          const args = operation === "history" ? ["log", "-10", "--format=medium", "--", path] : ["blame", "--no-textconv", "HEAD", "--", path]
          return evidence(`Git ${operation}`, await execute(git(...args)))
        }
        if (number === undefined) throw new Error("This GitHub read needs a PR, run or issue number.")
        const id = String(number)
        if (operation === "pr_comments") return evidence("Inline PR comments", await execute(["gh", "api", "--hostname", GH_HOST, "--method", "GET", `repos/${GHE_REPO}/pulls/${id}/comments`, "--paginate"]))
        const args = operation === "pr_view" ? ["pr", "view", id, "--json", "number,title,body,state,headRefName,headRefOid,statusCheckRollup,reviewDecision,comments,latestReviews"]
          : operation === "pr_diff" ? ["pr", "diff", id]
          : operation === "run_view" ? ["run", "view", id, "--json", "name,status,conclusion,jobs,headSha"]
          : operation === "run_logs" ? ["run", "view", id, "--log-failed"]
          : ["issue", "view", id, "--json", "title,body,comments"]
        return evidence(`GitHub ${operation} ${id}`, await github(...args))
      }
      case "observe": return observe(input.args, session.startedAt, abort.signal)
      case "submit_fix": return publish(input.args)
    }
  }
  // Serialize broker calls; publication independently stages an immutable, scanned snapshot.
  return (input) => {
    const result = pending.then(() => invoke(input))
    pending = result.then(() => {}, () => {})
    return result
  }
}
