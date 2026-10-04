import { describe, expect, test } from "bun:test"
import { type GuardContext, refusal } from "../src/sessions/guard.ts"
import { parseShell } from "../src/sessions/shell.ts"

const branch = "fix-bt-merkl-admin-v0-6-0"
const worktree = "/w"
/** Scripts the agent wrote in its worktree. */
const files: Record<string, string> = {
  "/w/x.sh": "#!/bin/bash\nset -e\nkubectl delete pod api-0\n",
  "/w/ok.sh": "#!/bin/sh\nbun type && bun test\n",
  "/w/plain": "git push origin main\n",
  "/w/tool.ts": "#!/usr/bin/env bun\nconsole.log('kubectl')\n",
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
  ]
  for (const command of bypasses) {
    test(`denies bypass: ${JSON.stringify(command)}`, () => expect(refusal(command, context)).toBeDefined())
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
})
