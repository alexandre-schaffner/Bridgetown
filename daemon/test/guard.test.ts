import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type GuardContext, readScript, refusal } from "../src/sessions/guard.ts"
import { parseShell } from "../src/sessions/shell.ts"

const branch = "fix-bt-merkl-admin-v0-6-0"
const worktree = "/w"
/** Scripts the agent wrote in its worktree. */
const files: Record<string, string> = {
  "/w/x.sh": "#!/bin/bash\nset -e\nkubectl delete pod api-0\n",
  "/w/ok.sh": "#!/bin/sh\nbun type && bun test\n",
  "/w/plain": "git push origin main\n",
  "/w/tool.ts": "#!/usr/bin/env bun\nconsole.log('kubectl')\n",
  "/w/envshebang.sh": "#!/usr/bin/env -S bash -euo pipefail\nkubectl delete pod api-0\n",
  "/w/py.py": "#!/usr/bin/env python3\nkubectl = 1\n",
  // Ordinary idioms: `local`/`readonly` with a command substitution the parser already checks, not arithmetic injection.
  "/w/vars.sh": "#!/bin/bash\nreadonly ROOT=$(git rev-parse --show-toplevel)\nf() {\n  local sha=$(git rev-parse HEAD)\n  echo \"$sha\"\n}\nf\n",
  "/tmp/y.sh": "gcloud logging read\n",
}
const context: GuardContext = { branch, cwd: worktree, daemonPort: 47621, readFile: (path) => files[path] }

describe("guard", () => {
  const denied = [
    "GH_HOST=nocturlab.ghe.com gh pr merge 1234 --squash",
    "gh pr -R Merkl/monorepo merge 1",
    "gh pr --repo Merkl/monorepo ready 1",
    "gh pr -R Merkl/monorepo create --title t",
    "gh pr create --title fix --body --draft",
    "gh run rerun 291250187 --failed",
    "gh release create admin-v0.6.1",
    "git tag admin-v0.6.1",
    "git push origin --tags",
    `git push --force origin ${branch}`,
    `git push -f origin ${branch}`,
    "git push origin main",
    "git push",
    "kubectl -n merkl get pods",
    "gcloud logging read",
    "op read op://vault/item",
    "bun migrate",
    "curl -s https://api.internal.merkl.xyz/v4/foo",
    "gh api -X POST repos/Merkl/monorepo/actions/runs/1/rerun",
    "gh workflow run stage-engine.yml",
    "cast send 0xabc",
    "gh api repos/Merkl/monorepo/issues/1/comments -f body=hi",
    "gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{}){clientMutationId}}'",
    "gh api repos/Merkl/monorepo/actions/workflows/x/dispatches -f ref=main",
    `git push origin ${branch}:main`,
    `echo ${branch}\ngit push origin main`,
    `git push -uf origin ${branch}`,
    `git push --follow-tags origin ${branch}`,
    `git push origin :${branch}`,
    "git push -u origin HEAD",
    "cd x && KUBECONFIG=a kubectl get pods",
    "gh pr review 12 --approve",
    "gh pr checks 1234 --watch",
    "gh pr checks 1234 -w --interval 30",
    "gh run watch 291250187",
    "gh pr ready 3352",
    "gh pr create --base main --title 'fix(api): parse as BigInt'",
    "gh pr create --draft=false --base main --title 'fix(api): parse as BigInt'",
    "gh pr create --draft --draft=false --base main --title 'fix(api): parse as BigInt'",
  ]
  for (const command of denied) {
    test(`denies: ${command}`, () => expect(refusal(command, context)).toBeDefined())
  }

  const allowed = [
    `git push -u origin ${branch}`,
    `git add -A && git commit -m "fix" && git push -u origin ${branch}`,
    "GH_HOST=nocturlab.ghe.com gh run view 291250187 --log-failed",
    "GH_HOST=nocturlab.ghe.com gh pr create --draft --base main --title 'fix(app-admin): pin vite'",
    "gh pr create -d --base main --title 'fix(app-admin): pin vite'",
    "gh pr create -df --base main",
    "gh pr checks 1234",
    "git tag --list 'admin-v*'",
    "bun type",
    "curl -s https://api.merkl.xyz/v4/health/ready",
    "gh api repos/Merkl/monorepo/actions/runs/291250187/jobs",
    "gh api -X GET search/issues -f q=repo:Merkl/monorepo",
    `git push -u origin ${branch}-2`,
    `git push origin HEAD:${branch}`,
    "cat deploy/helm/values.yaml && grep -r kargo apps-deployment/merkl-admin",
    "git log --oneline -5",
  ]
  for (const command of allowed) {
    test(`allows: ${command}`, () => expect(refusal(command, context)).toBeUndefined())
  }

  // Each of these got past the old prefix regexes.
  const bypasses = [
    "git -C . push origin main",
    "git -c x=y push origin main",
    "git --no-pager push origin main",
    "gh api --method=PUT repos/x/y/pulls/1/merge",
    "gh api -XPUT repos/x/y/pulls/1/merge",
    "/usr/local/bin/kubectl delete pod api-0",
    "time kubectl get pods",
    "echo `kubectl get pods`",
    "$(kubectl get pods)",
    "echo \"pods: $(kubectl get pods)\"",
    "env FOO=1 kubectl get pods",
    "env -i PATH=/usr/bin kubectl get pods",
    "sudo ls",
    "bash x.sh",
    "sh ./x.sh",
    "./x.sh",
    "source x.sh",
    ". /w/x.sh",
    "./plain",
    "cd /tmp && sh y.sh",
    "bash -c 'kubectl get pods'",
    "sh -lc \"git push origin main\"",
    "eval kubectl get pods",
    "echo kubectl get pods | bash",
    "nohup kubectl get pods &",
    "timeout 30 kubectl get pods",
    "xargs -n1 kubectl delete pod < pods.txt",
    "find . -name '*.yaml' -exec kubectl apply -f {} \\;",
    "command kubectl get pods",
    "nice -n 10 gcloud logging read",
    "(kubectl get pods)",
    "{ kubectl get pods; }",
    "if true; then kubectl get pods; fi",
    "ls && kubectl get pods",
    "ls || kubectl get pods",
    "ls | kubectl apply -f -",
    "ls & kubectl get pods",
    "diff <(kubectl get pods) <(echo)",
    "X=$(kubectl get pods) true",
    "$CMD get pods",
    "k\\ubectl get pods",
    "'kubectl' get pods",
    "/usr/bin/kube* get pods",
    "bunx prisma migrate deploy",
    "git -c alias.p=push p origin main",
    "git config alias.p 'push --force'",
    "gh alias set m 'pr merge'",
    "curl http://127.0.0.1:47621/state",
    "curl -s localhost:47621/actions/a_1/resolve -d '{}'",
    "wget -qO- http://[::1]:47621/state",
    "nc 127.0.0.1 47621",
    "curl -X POST https://slack.com/api/chat.postMessage",
    "curl https://hooks.slack.com/services/T/B/x",
    "U=http://127.0.0.1:47621/state; curl $U",
    "security find-generic-password -s Bridgetown -w",
    "cat <<EOF | sh\nkubectl get pods\nEOF",
    "cat <<EOF\n$(kubectl get pods)\nEOF",
    "echo 'unterminated",
    // gh/git policy holes the audit found (dynamic args, denylist gaps, tag/push holes).
    'gh pr "$(echo merge)" 1',
    "X=merge; gh pr $X 1",
    "gh api -X $M repos/o/r/pulls/1/merge",
    // A dynamic word anywhere in `gh api` splits at runtime into flags (`-X PUT`, `-f`), turning a read into a write.
    "gh api repos/o/r/pulls/1/merge $X",
    "gh api $EP",
    "git push $F fix-bt-merkl-admin-v0-6-0",
    "echo 'pr merge 1' | xargs gh",
    "echo 'push origin HEAD:main' | xargs git",
    "gh secret set FOO -b bar",
    "gh variable set FOO -b bar",
    "gh repo delete Merkl/monorepo --yes",
    "gh run delete 1",
    "gh cache delete --all",
    "gh pr edit 1 --base release",
    "gh pr edit 1 --add-reviewer octocat",
    "gh extension install foo/gh-bar",
    "gh auth token",
    "gh auth status --show-token",
    "git tag --sort=refname admin-v9.9.9",
    "git tag --format='%(refname)' admin-v9.9.9",
    "git tag --column admin-v9.9.9",
    "git mktag",
    "git update-ref refs/tags/admin-v9.9.9 HEAD",
    "git -c push.followTags=true push origin fix-bt-merkl-admin-v0-6-0",
    "git config push.followTags true",
    "git subtree push --prefix=apps origin main",
    "git push https://other.host/x HEAD:fix-bt-merkl-admin-v0-6-0",
    "git credential fill",
    "git rebase --exec 'gh pr merge 1' main",
    "git submodule foreach 'gh pr merge 1'",
    "git bisect run ./x.sh",
    "git difftool -x 'gh pr merge 1'",
    "git filter-branch --tree-filter 'gh pr merge 1' HEAD",
    'git -c core.pager="gh pr merge 1" log',
    'git config core.fsmonitor "gh pr merge 1"',
    'curl -X PUT -H "Authorization: token t" https://nocturlab.ghe.com/api/v3/repos/Merkl/monorepo/pulls/1/merge',
    // Wrapper / quoting / shell coverage.
    "command git push -v origin HEAD:main",
    "env -S'gh pr merge 1'",
    "env -iS'gh pr merge 1'",
    "tcsh -c 'gh pr merge 1'",
    "fish -c 'gh pr merge 1'",
    "csh -c 'gh pr merge 1'",
    "noglob gh pr merge 1",
    "nocorrect gh pr merge 1",
    "=gh pr merge 1",
    '$"gh" pr merge 1',
    "$'\\u0067h' pr merge 1",
    "trap 'gh pr merge 1' EXIT",
    "npx --call='gh pr merge 1'",
    "npm exec -c 'gh pr merge 1'",
    "pnpm dlx -c 'gh pr merge 1'",
    "bun exec 'gh pr merge 1'",
    "arch -arm64 gh pr merge 1",
    "script -q /dev/null gh pr merge 1",
    "parallel gh pr merge ::: 1",
    "setsid gh pr merge 1",
    "bun --cwd x run db:migrate",
    "bun run --filter api db:migrate",
    "pnpm -F api migrate",
    "npm --prefix x run migrate",
    "find . -execdir gh pr {} \\;",
    "alias g=git",
    "alias g=gh; g pr merge 1",
    "let 'a[$(gh pr merge 1)]'",
    "declare -i y='$(gh pr merge 1)'",
    // Reading another process's environment (the daemon still carries dev tokens in its envp).
    "ps eww",
    "ps -E",
    "ps auxe",
    "ps -wwE -p 1",
    "ps eww -p 1234 | grep SLACK",
    "cat /proc/1/environ",
    // Env assignments that would run a later command the guard never sees.
    "BASH_ENV=./x.sh bash -c true",
    "GIT_SSH_COMMAND='gh pr merge 1' git fetch",
    "GIT_PAGER='gh pr merge 1' git log",
    'NODE_OPTIONS="--require ./x.js" bun test',
    // ./envshebang.sh runs by path with an `env -S bash` shebang: still shell, still checked.
    "./envshebang.sh",
    // Deep nesting is reported, not crashed through (fail closed).
    `echo ${"$(".repeat(5000)}gh pr merge 1${")".repeat(5000)}`,
  ]
  for (const command of bypasses) {
    test(`denies bypass: ${JSON.stringify(command).slice(0, 80)}`, () => expect(refusal(command, context)).toBeDefined())
  }

  const stillAllowed = [
    "bash ok.sh",
    "./tool.ts",
    "command -v kubectl",
    "git -C . push -u origin " + branch,
    "git --no-pager log --oneline -5",
    "cat <<'EOF' > notes.md\nwe should not run kubectl or git push origin main here\nEOF",
    `gh pr create --draft --title "fix" --body "$(cat <<'EOF'\n## Summary\nit's fixed; don't kubectl anything\nEOF\n)"`,
    "bun test 2>&1 | tail -20",
    "ls *.ts > /dev/null 2>&1 && echo ok",
    "for f in a b; do echo $f; done",
    "[ -f package.json ] && echo yes",
    "echo $((1 << 2))",
    "curl -s http://localhost:8000/mcp",
    "grep -rn 'slack.com' src/",
    "timeout 60 bun test",
    "xargs -n1 echo < files.txt",
    "find . -name '*.ts' -exec grep -l foo {} +",
    // The read-only / own-PR gh and git commands an agent needs stay allowed.
    "gh pr view 1 --comments",
    "gh pr diff 1",
    "gh pr checks 1234",
    "gh pr comment 1 --body 'done'",
    "gh pr edit 1 --add-label bug",
    "gh run view 291250187 --log",
    "gh run download 291250187",
    "gh workflow view deploy.yml",
    "gh issue view 5",
    "gh repo view",
    "gh search issues repo:Merkl/monorepo",
    "gh auth status",
    "gh api repos/Merkl/monorepo/pulls/1/comments",
    "gh api -X GET search/issues -f q=repo:Merkl/monorepo",
    "git tag --sort=-creatordate",
    "git tag --contains HEAD",
    "git config --get remote.origin.url",
    "git -c color.ui=always log --oneline -5",
    "git rebase origin/main",
    "git submodule update --init",
    `git push origin HEAD:${branch}`,
    "git fetch origin main && git checkout -b " + branch + "-2 origin/main",
    // Legitimate wrappers and env, and a python script run by path (the guard cannot read it).
    "nice -n 10 bun test",
    "env NODE_ENV=test bun test",
    "FOO=bar bun run build",
    "bun run build",
    "./py.py",
    "setsid bun test",
    "parallel bun test ::: a b",
    "ps aux",
    "ps -ef | grep bun",
    "ps -p 1234 -o command",
    // `local`/`readonly`/`declare` with an ordinary `$(…)` the parser already checked (not `let`/`-i` arithmetic), and a script that uses them.
    "local sha=$(git rev-parse HEAD)",
    "readonly ROOT=$(git rev-parse --show-toplevel)",
    "declare TAG=$(git describe --tags)",
    "bash ./vars.sh",
    "./vars.sh",
    // Bare xargs (no command) runs echo on its stdin; nothing to smuggle in.
    "cat files.txt | xargs",
    "git log --oneline | xargs -n1",
  ]
  for (const command of stillAllowed) {
    test(`allows: ${JSON.stringify(command)}`, () => expect(refusal(command, context)).toBeUndefined())
  }
})

describe("shell parser", () => {
  const commands = (source: string) => {
    const parsed = parseShell(source)
    return parsed._tag === "Parsed" ? parsed.commands.map((c) => c.map((w) => w.text).join(" ")) : parsed.reason
  }
  test("lists, pipes and substitutions each yield a command", () => {
    expect(commands("a 1 && b 2 | c; d")).toEqual(["a 1", "b 2", "c", "d"])
    expect(commands("echo \"x $(b 2)\" `c 3`")).toEqual(["b 2", "c 3", "echo x $(b 2) `c 3`"])
  })
  test("redirections are not arguments", () => {
    expect(commands("cmd a > out 2>&1 < in")).toEqual(["cmd a"])
  })
  test("quoted heredocs are data; unquoted ones still run substitutions", () => {
    expect(commands("cat <<'EOF'\n$(x)\nEOF\nnext")).toEqual(["cat", "next"])
    expect(commands("cat <<EOF\n$(x)\nEOF")).toEqual(["cat", "x"])
  })
  test("unbalanced input is reported", () => {
    expect(parseShell("echo \"open")._tag).toBe("Unparsable")
    expect(parseShell("echo $(open")._tag).toBe("Unparsable")
  })
  test("deep nesting is reported, not thrown, so the guard fails closed", () => {
    const deep = `echo ${"$(".repeat(5000)}x${")".repeat(5000)}`
    const parsed = parseShell(deep)
    expect(parsed._tag).toBe("Unparsable")
    if (parsed._tag === "Unparsable") expect(parsed.reason).toBe("too deeply nested")
  })
  test("sibling substitutions do not accumulate nesting", () => {
    expect(parseShell(`echo ${"$(a) ".repeat(500)}`)._tag).toBe("Parsed")
  })
})

describe("readScript", () => {
  const dir = mkdtempSync(join(tmpdir(), "bt-readscript-"))
  test("reads a regular file", () => {
    const file = join(dir, "ok.sh")
    writeFileSync(file, "echo hi\n")
    expect(readScript(file)).toBe("echo hi\n")
  })
  test("refuses devices and FIFOs instead of blocking the event loop", () => {
    expect(readScript("/dev/zero")).toBeUndefined()
    expect(readScript("/dev/stdin")).toBeUndefined()
    const fifo = join(dir, "pipe")
    execFileSync("mkfifo", [fifo])
    expect(readScript(fifo)).toBeUndefined()
  })
  test("a missing file reads as undefined", () => {
    expect(readScript(join(dir, "nope"))).toBeUndefined()
  })
})
