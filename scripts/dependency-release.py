#!/usr/bin/env python3
"""Daily Dependabot patch batch. Reads PR data; never runs code from a PR."""

import argparse
import base64
import copy
import json
import os
import re
import subprocess
import time
from urllib.parse import quote


ALLOW = {
    "daemon": {"zod", "@types/bun", "typescript"},
    "site": {
        "@fontsource-variable/geist", "@fontsource-variable/geist-mono",
        "gsap", "lenis", "lucide-static", "three", "@types/bun",
        "@types/three", "playwright-core", "typescript",
    },
}
SENSITIVE = ("@anthropic-ai/", "@effect/", "effect", "@typesafe-ai/", "@modelcontextprotocol/")
RELEASE_BRANCH = "release-please--branches--main--components--bridgetown"
RELEASE_FILES = {".release-please-manifest.json", "CHANGELOG.md", "app/Info.plist", "daemon/package.json", "daemon/src/config.ts"}


def version(value):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", value)
    return tuple(map(int, match.groups())) if match else None


def patch(before, after):
    old, new = version(before), version(after)
    return old is not None and new is not None and old[:2] == new[:2] and new[2] > old[2]


def lock_json(text):
    # Bun's lockfile is JSON with trailing commas. Only strip commas outside strings.
    tokens = re.findall(r'"(?:\\.|[^"\\])*"|[^"]+', text)
    return json.loads("".join(token if token.startswith('"') else re.sub(r",(?=\s*[}\]])", "", token) for token in tokens))


def dependency_patch(folder, old_manifest, new_manifest, old_lock, new_lock):
    """Reject source edits, manifest behavior changes, and non-patch lockfile changes."""
    before, after = copy.deepcopy(old_manifest), copy.deepcopy(new_manifest)
    direct = set()
    for section in ("dependencies", "devDependencies"):
        left, right = before.pop(section, {}), after.pop(section, {})
        if left.keys() != right.keys():
            return False
        direct.update(left)
        for name in left:
            if left[name] != right[name]:
                old = re.fullmatch(r"([~^]?)(\d+\.\d+\.\d+)", left[name])
                new = re.fullmatch(r"([~^]?)(\d+\.\d+\.\d+)", right[name])
                if name not in ALLOW[folder] or not old or not new or old[1] != new[1] or not patch(old[2], new[2]):
                    return False
    if before != after:
        return False
    left, right = copy.deepcopy(old_lock), copy.deepcopy(new_lock)
    old_packages, new_packages = left.pop("packages"), right.pop("packages")
    if old_packages.keys() != new_packages.keys():
        return False
    # Workspace declarations must agree with the manifests, including scripts and names.
    for lock, manifest in ((left, old_manifest), (right, new_manifest)):
        workspace = lock.get("workspaces", {}).get("", {})
        for section in ("dependencies", "devDependencies"):
            if workspace.pop(section, {}) != manifest.get(section, {}):
                return False
    if left != right:
        return False
    changed_direct = set()
    for key in old_packages:
        old_entry, new_entry = old_packages[key], new_packages[key]
        if old_entry == new_entry:
            continue
        name, old = old_entry[0].rsplit("@", 1)
        new_name, new = new_entry[0].rsplit("@", 1)
        if name != new_name or name.startswith(SENSITIVE) or not patch(old, new):
            return False
        if key in direct:
            if key not in ALLOW[folder]:
                return False
            changed_direct.add(key)
    return bool(changed_direct)


class GitHub:
    def __init__(self, repo):
        self.repo = repo

    def api(self, path, method="GET", payload=None):
        args = ["gh", "api", f"repos/{self.repo}/{path}", "--method", method]
        if payload is not None:
            args += ["--input", "-"]
        result = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                                text=True, capture_output=True, check=True)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def pages(self, path):
        result = subprocess.run(["gh", "api", f"repos/{self.repo}/{path}", "--paginate", "--slurp"],
                                text=True, capture_output=True, check=True)
        return [item for page in json.loads(result.stdout) for item in page]

    def content(self, ref, path):
        data = self.api(f"contents/{path}?ref={quote(ref, safe='')}")
        return base64.b64decode(data["content"]).decode()

    def main_sha(self):
        return self.api("git/ref/heads/main")["object"]["sha"]

    def compare(self, base, head):
        data = self.api(f"compare/{quote(base, safe='')}...{quote(head, safe='')}")
        if data["total_commits"] > 250 or len(data.get("files", [])) >= 300:
            raise RuntimeError("Change set too large to validate")
        return data

    def safe_diff(self, base, head, neutral=False):
        files = self.compare(base, head)["files"]
        paths = {file["filename"] for file in files}
        dependency_paths = {f"{folder}/{name}" for folder in ALLOW for name in ("package.json", "bun.lock")}
        allowed = dependency_paths | {"README.md", ".gitignore", "scripts/dependency-release.py", "scripts/test_dependency_release.py"} if neutral else dependency_paths
        for file in files:
            path = file["filename"]
            if path in dependency_paths:
                if file["status"] != "modified":
                    return False
            elif not neutral or file["status"] not in ("added", "modified") or (path not in allowed and not path.startswith(".github/")):
                return False
        changed = False
        for folder in ALLOW:
            if not paths.intersection({f"{folder}/package.json", f"{folder}/bun.lock"}):
                continue
            manifests = [json.loads(self.content(ref, f"{folder}/package.json")) for ref in (base, head)]
            locks = [lock_json(self.content(ref, f"{folder}/bun.lock")) for ref in (base, head)]
            if not dependency_patch(folder, *manifests, *locks):
                return False
            changed = True
        return changed

    def ci_green(self, sha):
        runs = self.api(f"actions/workflows/ci.yml/runs?head_sha={sha}&per_page=100")["workflow_runs"]
        # Bot-created PR runs may require approval; the explicit dispatch is authoritative.
        runs = [run for run in runs if run["conclusion"] != "action_required"]
        return bool(runs) and runs[0]["status"] == "completed" and runs[0]["conclusion"] == "success"

    def dispatch_wait(self, workflow, ref, sha=None, inputs=None):
        previous = self.api(f"actions/workflows/{workflow}/runs?per_page=1")["workflow_runs"]
        previous_id = previous[0]["id"] if previous else 0
        dispatch_inputs = dict(inputs or {})
        if workflow == "release.yml" and sha:
            dispatch_inputs["expected_sha"] = sha
        self.api(f"actions/workflows/{workflow}/dispatches", "POST", {"ref": ref, "inputs": dispatch_inputs})
        deadline = time.monotonic() + 2400
        while time.monotonic() < deadline:
            if ref == "main" and sha and self.main_sha() != sha:
                raise RuntimeError("Main changed after workflow dispatch; stopping this batch")
            runs = self.api(f"actions/workflows/{workflow}/runs?event=workflow_dispatch&per_page=100")["workflow_runs"]
            candidates = [run for run in runs if run["id"] > previous_id and run["head_branch"] == ref and (sha is None or run["head_sha"] == sha)]
            if candidates:
                run = min(candidates, key=lambda item: item["id"])
                if run["status"] == "completed":
                    print(f"{workflow}: {run['conclusion']} ({run['html_url']})", flush=True)
                    if run["conclusion"] != "success":
                        raise RuntimeError(f"{workflow} failed; leaving the batch for manual attention")
                    return run
            time.sleep(20)
        raise RuntimeError(f"Timed out waiting for {workflow}")

    def idle(self):
        for workflow in ("release.yml", "deploy-site.yml", "ci.yml"):
            runs = self.api(f"actions/workflows/{workflow}/runs?branch=main&per_page=100")["workflow_runs"]
            if any(run["status"] != "completed" for run in runs):
                return False
            if runs and runs[0]["conclusion"] != "success":
                return False
        return not any(release["draft"] for release in self.pages("releases?per_page=100"))

    def merge(self, pr, sha):
        result = self.api(f"pulls/{pr['number']}/merge", "PUT", {
            "sha": sha, "merge_method": "squash", "commit_title": f"{pr['title']} (#{pr['number']})",
        })
        if not result["merged"]:
            raise RuntimeError(result["message"])
        print(f"Merged #{pr['number']} at {result['sha']}", flush=True)
        return result["sha"]


def release_metadata_valid(github, base, head, old_version):
    old = version(old_version)
    expected = f"{old[0]}.{old[1]}.{old[2] + 1}"
    files = github.compare(base, head)["files"]
    if {file["filename"] for file in files} != RELEASE_FILES or any(file["status"] != "modified" for file in files):
        return False
    for path in RELEASE_FILES:
        before, after = [github.content(ref, path) for ref in (base, head)]
        if path == "CHANGELOG.md":
            if not after.endswith(before.removeprefix("# Changelog\n")) or f"## [{expected}]" not in after:
                return False
        elif path == "daemon/package.json":
            left, right = json.loads(before), json.loads(after)
            if left.pop("version") != old_version or right.pop("version") != expected or left != right:
                return False
        elif after != before.replace(old_version, expected):
            return False
    return True


def run(github, apply):
    if not github.idle():
        print("Hold: a release/deployment is active or failed, or a draft needs attention")
        return
    latest = github.api("releases/latest")
    if not latest.get("immutable") or not re.fullmatch(r"v\d+\.\d+\.\d+", latest["tag_name"]):
        raise RuntimeError("Latest release must be immutable and have a stable semver tag")
    prs = github.pages("pulls?state=open&base=main&per_page=100")
    merged = False
    for pr in sorted(prs, key=lambda item: item["number"]):
        if pr["user"]["login"] != "dependabot[bot]" or pr["draft"] or pr["head"]["repo"]["full_name"] != github.repo:
            continue
        base, head = github.main_sha(), pr["head"]["sha"]
        if not re.match(r"^(deps|chore)(\([^)]*\))?: ", pr["title"]):
            continue
        if not github.safe_diff(base, head) or not github.ci_green(head):
            print(f"Manual or not green: #{pr['number']}", flush=True)
            continue
        print(f"Eligible patch: #{pr['number']}", flush=True)
        if apply:
            github.merge(pr, head)
            merged = True
    main = github.main_sha()
    # Always check/deploy bot merges, even when unrelated changes hold an app release.
    if apply and merged:
        github.dispatch_wait("ci.yml", "main", main)
        if github.main_sha() != main or not github.idle():
            raise RuntimeError("Main or release state changed during CI; retry on the next batch")
        github.dispatch_wait("deploy-site.yml", "main", main)
    if not github.safe_diff(latest["tag_name"], main, neutral=True):
        print("No dependency-only patch release; source or manual dependency changes need review")
        return
    old_manifest = json.loads(github.content(latest["tag_name"], "daemon/package.json"))
    old_lock, new_lock = [lock_json(github.content(ref, "daemon/bun.lock")) for ref in (latest["tag_name"], main)]
    runtime_changed = any(old_lock["packages"][name] != new_lock["packages"][name] for name in old_manifest["dependencies"])
    if not apply:
        print("Would check main and " + ("test/merge the next patch release, publish and deploy" if runtime_changed else "deploy the site without an app release"))
        return
    if not merged:
        if not runtime_changed:
            deploys = github.api("actions/workflows/deploy-site.yml/runs?branch=main&per_page=1")["workflow_runs"]
            if deploys and deploys[0]["head_sha"] == main and deploys[0]["conclusion"] == "success":
                print("This site/tooling batch is already deployed")
                return
        if not github.ci_green(main):
            github.dispatch_wait("ci.yml", "main", main)
    if github.main_sha() != main or not github.idle():
        raise RuntimeError("Main or release state changed during CI; retry on the next batch")
    if not runtime_changed:
        if not merged:
            github.dispatch_wait("deploy-site.yml", "main", main)
        print("Tooling/site patch batch verified; no app release needed")
        return
    # GITHUB_TOKEN merges don't trigger push workflows. A tag-less dispatch reconciles main.
    github.dispatch_wait("release.yml", "main", main)
    releases = [pr for pr in github.pages("pulls?state=open&base=main&per_page=100")
                if pr["head"]["ref"] == RELEASE_BRANCH and pr["user"]["login"] == "github-actions[bot]"
                and pr["head"]["repo"]["full_name"] == github.repo and not pr["draft"]]
    if len(releases) != 1:
        raise RuntimeError("Expected exactly one release-please PR")
    pr = releases[0]
    head = pr["head"]["sha"]
    # Refresh the release branch onto the main commit tested above before testing it.
    if github.compare(main, head)["merge_base_commit"]["sha"] != main:
        github.api(f"pulls/{pr['number']}/update-branch", "PUT", {"expected_head_sha": head})
        for _ in range(30):
            time.sleep(2)
            pr = github.api(f"pulls/{pr['number']}")
            head = pr["head"]["sha"]
            if github.compare(main, head)["merge_base_commit"]["sha"] == main:
                break
        else:
            raise RuntimeError("Release branch did not refresh")
    if not release_metadata_valid(github, main, head, latest["tag_name"][1:]):
        raise RuntimeError("Release PR must contain only the next patch version and changelog")
    if not github.ci_green(head):
        github.dispatch_wait("ci.yml", RELEASE_BRANCH, head)
    if github.main_sha() != main or not github.idle():
        raise RuntimeError("Main or release state changed during release CI")
    sha = github.merge(pr, head)
    github.dispatch_wait("release.yml", "main", sha)
    old = version(latest["tag_name"][1:])
    expected = f"v{old[0]}.{old[1]}.{old[2] + 1}"
    release = github.api(f"releases/tags/{expected}")
    if release["draft"] or not release.get("immutable"):
        raise RuntimeError("New immutable release not found after publish/deploy")
    print(f"Released and deployed: {release['html_url']}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Merge and release; default is read-only")
    args = parser.parse_args()
    run(GitHub(os.environ["GH_REPO"]), args.apply)
