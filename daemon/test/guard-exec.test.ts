import { describe, expect, test } from "bun:test"
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EXEC_GUARDED, readScript } from "../src/sessions/guard.ts"
import { execVerdict, installShims, realBinary } from "../src/sessions/guard-exec.ts"
import { scratchDir } from "./fixtures/tmp.ts"

const branch = "fix-bt-merkl-api-ab12"
const root = scratchDir("bt-guard-exec-")
const shims = join(root, "guard-bin")
const bin = join(root, "bin")
const work = join(root, "work")
mkdirSync(bin)
mkdirSync(work)
/** Stand-ins for the real binaries: each prints its name and argv. */
for (const name of ["git", "gh", "kubectl", "curl"]) writeFileSync(join(bin, name), `#!/bin/sh\necho "real ${name} $*"\n`, { mode: 0o755 })
// What a session could leave in its worktree to steer a bun process started there.
writeFileSync(join(work, "bunfig.toml"), 'preload = ["./steer.ts"]\n')
writeFileSync(join(work, "steer.ts"), `process.stdout.write(${JSON.stringify(join(bin, "git"))}); process.exit(0)\n`)
writeFileSync(join(work, ".env"), "BRIDGETOWN_BRANCH=main\n")
writeFileSync(join(work, "deploy.sh"), "kubectl apply -f k8s\n")
installShims(shims, 47621)
const path = `${shims}:${bin}:/usr/bin:/bin`

const verdict = (name: string, ...args: ReadonlyArray<string>) =>
  execVerdict({ name, args, shims, context: { branch, cwd: work, daemonPort: 47621, readFile: readScript } }, path)

describe("the exec-time guard's verdict", () => {
  test("the policy runs on the real argv; an allowed one runs the real binary", () => {
    expect(verdict("git", "status")).toEqual({ _tag: "Run", path: join(bin, "git") })
    expect(verdict("git", "push", "-u", "origin", branch)).toEqual({ _tag: "Run", path: join(bin, "git") })
    expect(verdict("git", "-c", "core.pager=", "-c", "core.hooksPath=/dev/null", "log")._tag).toBe("Run")
    expect(verdict("git", "push", "origin", "main")._tag).toBe("Refused")
    expect(verdict("gh", "pr", "merge", "1")._tag).toBe("Refused")
    expect(verdict("gh", "pr", "checks", "12", "--watch")._tag).toBe("Refused")
    expect(verdict("kubectl", "get", "pods")._tag).toBe("Refused")
    expect(verdict("curl", "-s", "http://127.0.0.1:47621/state")._tag).toBe("Refused")
  })

  test("the credential plumbing gh and git run on their own passes", () => {
    // git's credential helper (config.ts) and git-lfs's lookup.
    expect(verdict("gh", "auth", "git-credential", "get")._tag).toBe("Run")
    expect(verdict("git", "credential", "fill")._tag).toBe("Run")
    // gh hands the git it runs its own helper, by its real path or by name.
    const ghFetch = (gh: string) => verdict("git", "-c", "credential.helper=", "-c", `credential.https://nocturlab.ghe.com.helper=!"${gh}" auth git-credential`, "fetch", "origin")
    expect(ghFetch(join(bin, "gh"))._tag).toBe("Run")
    expect(ghFetch("gh")._tag).toBe("Run")
    // A "gh" the session wrote is not gh.
    expect(ghFetch(join(work, "gh"))._tag).toBe("Refused")
    // Only the plumbing: the token is still refused, and so is a push to main next to gh's helper.
    expect(verdict("gh", "auth", "token")._tag).toBe("Refused")
    expect(verdict("git", "-c", `credential.helper=!"${join(bin, "gh")}" auth git-credential`, "push", "origin", "main")._tag).toBe("Refused")
  })

  test("the real binary is the first outside the shims, never a relative PATH entry", () => {
    const link = join(root, "guard-bin-link")
    symlinkSync(shims, link)
    expect(realBinary("git", `${link}:.:${bin}`, shims)).toBe(join(bin, "git"))
    expect(execVerdict({ name: "git", args: ["status"], shims, context: { branch, cwd: work, daemonPort: 47621, readFile: readScript } }, `${shims}:${join(root, "none")}`)).toEqual({
      _tag: "NotFound",
    })
  })
})

describe("the shims", () => {
  test("one read-only executable per guarded command, and not security, which the Claude CLI runs for its own login", () => {
    expect(readdirSync(shims).sort()).toEqual([...EXEC_GUARDED].sort())
    expect(EXEC_GUARDED).not.toContain("security")
    for (const name of EXEC_GUARDED) {
      accessSync(join(shims, name), constants.X_OK)
      expect(statSync(join(shims, name)).mode & 0o222).toBe(0)
    }
  })

  test("each turn puts back a shim the session changed and removes anything else, leaving the rest alone", () => {
    const dir = join(scratchDir("bt-shims-"), "guard-bin")
    installShims(dir, 47621)
    const untouched = statSync(join(dir, "gh")).mtimeMs
    writeFileSync(join(dir, "stray"), "")
    // Read-only, so replacing one takes deleting it first.
    rmSync(join(dir, "kubectl"))
    writeFileSync(join(dir, "kubectl"), "#!/bin/sh\nexec /usr/local/bin/kubectl \"$@\"\n", { mode: 0o755 })
    Bun.sleepSync(5)
    installShims(dir, 47621)
    expect(readdirSync(dir)).not.toContain("stray")
    expect(readFileSync(join(dir, "kubectl"), "utf8")).toContain("--guard-exec")
    expect(statSync(join(dir, "gh")).mtimeMs).toBe(untouched)
  })
})

describe("a shim on PATH, end to end", () => {
  const sh = (command: string, env: Record<string, string> = {}) => {
    const result = Bun.spawnSync(["/bin/sh", "-c", command], { cwd: work, env: { PATH: path, BRIDGETOWN_BRANCH: branch, ...env } })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }

  test("an allowed command runs the real binary with its argv", () => {
    expect(sh("git status")).toEqual({ code: 0, out: "real git status\n", err: "" })
    expect(sh(`git push -u origin ${branch}`).out).toBe(`real git push -u origin ${branch}\n`)
  }, 30_000)

  test("what the command line could not see is refused when it runs", () => {
    for (const command of ["x=gh; $x pr merge 1", "sh deploy.sh", "git push origin main"]) {
      const result = sh(command)
      expect(result.code).toBe(126)
      expect(result.out).toBe("")
      expect(result.err).toStartWith("Bridgetown refused")
    }
  }, 30_000)

  test("the worktree's bunfig.toml preload and .env don't reach the guard, and the branch is the session's", () => {
    // Both would make the guard pass `git push origin main`: the preload by printing the real path, the .env by naming main the session's branch.
    expect(sh("git push origin main").err).toContain(`git push -u origin ${branch}`)
    expect(sh("git push origin main", { BUN_OPTIONS: `--preload ${join(work, "steer.ts")}` }).code).toBe(126)
  }, 30_000)
})
