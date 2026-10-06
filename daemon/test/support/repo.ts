import { execSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { scratchDir } from "./tmp.ts"

export const sh = (cmd: string, cwd: string): string => execSync(cmd, { cwd, stdio: "pipe" }).toString().trim()

export const commit = (message: string, cwd: string): string =>
  sh(`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm ${JSON.stringify(message)}`, cwd)

/** A repo laid out like the monorepo: worktrees go under `.shared/worktrees`, and `origin` is a bare repo next to it. */
export const scratchRepo = (manifest?: object): string => {
  const root = scratchDir("bt-wt-")
  const repo = join(root, "repo")
  mkdirSync(join(repo, ".shared"), { recursive: true })
  if (manifest !== undefined) writeFileSync(join(repo, "package.json"), JSON.stringify(manifest))
  writeFileSync(join(repo, ".shared", ".keep"), "")
  sh("git init -q -b main && git add -A", repo)
  commit("init", repo)
  sh(`git init -q --bare ${join(root, "origin.git")}`, root)
  sh(`git remote add origin ${join(root, "origin.git")} && git push -q origin main`, repo)
  return repo
}
