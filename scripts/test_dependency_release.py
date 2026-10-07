import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import dependency_release as policy


def fixture(name="zod", old="4.1.0", new="4.1.1", section="dependencies"):
    before = {"name": "test", "scripts": {"build": "bun build"}, section: {name: f"^{old}"}}
    after = copy.deepcopy(before)
    after[section][name] = f"^{new}"
    left = {"lockfileVersion": 1, "workspaces": {"": {"name": "test", section: {name: f"^{old}"}}},
            "packages": {name: [f"{name}@{old}", "", {}, "old-hash"]}}
    right = copy.deepcopy(left)
    right["workspaces"][""][section][name] = f"^{new}"
    right["packages"][name] = [f"{name}@{new}", "", {}, "new-hash"]
    return before, after, left, right


class DependencyPolicyTests(unittest.TestCase):
    def test_patch_update(self):
        self.assertTrue(policy.dependency_patch("daemon", *fixture()))

    def test_minor_major_prerelease_downgrade_and_same_version(self):
        for new in ("4.2.0", "5.0.0", "4.1.1-beta.1", "4.0.9", "4.1.0"):
            with self.subTest(new=new):
                self.assertFalse(policy.dependency_patch("daemon", *fixture(new=new)))

    def test_sensitive_runtime_and_unlisted_packages(self):
        for name in ("@anthropic-ai/claude-agent-sdk", "effect", "@effect/platform-bun", "@modelcontextprotocol/sdk", "unknown"):
            self.assertFalse(policy.dependency_patch("daemon", *fixture(name=name)))

    def test_sensitive_transitive_update(self):
        before, after, left, right = fixture()
        left["packages"]["effect"] = ["effect@4.0.0"]
        right["packages"]["effect"] = ["effect@4.0.1"]
        self.assertFalse(policy.dependency_patch("daemon", before, after, left, right))

    def test_mixed_patch_and_minor_group(self):
        before, after, left, right = fixture()
        for manifest, lock, v in ((before, left, "7.0.0"), (after, right, "7.1.0")):
            manifest["dependencies"]["typescript"] = v
            lock["workspaces"][""]["dependencies"]["typescript"] = v
            lock["packages"]["typescript"] = [f"typescript@{v}"]
        self.assertFalse(policy.dependency_patch("daemon", before, after, left, right))

    def test_manifest_script_change(self):
        before, after, left, right = fixture()
        after["scripts"]["build"] = "different command"
        self.assertFalse(policy.dependency_patch("daemon", before, after, left, right))

    def test_manifest_and_lockfile_disagree(self):
        before, after, left, right = fixture()
        right["workspaces"][""]["dependencies"]["zod"] = "^4.2.0"
        self.assertFalse(policy.dependency_patch("daemon", before, after, left, right))

    def test_new_dependency_or_lockfile_package_requires_review(self):
        before, after, left, right = fixture()
        right["packages"]["new"] = ["new@1.0.0"]
        self.assertFalse(policy.dependency_patch("daemon", before, after, left, right))

    def test_lockfile_only_patch_in_unchanged_range(self):
        before, after, left, right = fixture()
        after["dependencies"] = before["dependencies"].copy()
        right["workspaces"][""]["dependencies"] = left["workspaces"][""]["dependencies"].copy()
        self.assertTrue(policy.dependency_patch("daemon", before, after, left, right))

    def test_site_typography_patch(self):
        self.assertTrue(policy.dependency_patch("site", *fixture(name="@fontsource-variable/geist")))
        self.assertFalse(policy.dependency_patch("site", *fixture(name="wrangler")))

    def test_trailing_commas_preserve_strings(self):
        self.assertEqual(policy.lock_json('{"text":"comma, } and \\\"quote\\\"", "array":[1,\n ],\n}'),
                         {"text": 'comma, } and "quote"', "array": [1]})
        policy.lock_json(Path(__file__).resolve().parents[1].joinpath("daemon/bun.lock").read_text())
        policy.lock_json(Path(__file__).resolve().parents[1].joinpath("site/bun.lock").read_text())

    def test_source_or_renamed_file_rejected(self):
        github = policy.GitHub("owner/repo")
        for file in ({"filename": "daemon/src/main.ts", "status": "modified"},
                     {"filename": "daemon/bun.lock", "status": "renamed"}):
            with patch.object(github, "compare", return_value={"files": [file]}):
                self.assertFalse(github.safe_diff("base", "head"))

    def test_ci_requires_exact_sha_and_latest_result(self):
        github = policy.GitHub("owner/repo")
        for conclusion, expected in (("success", True), ("failure", False), ("cancelled", False)):
            with patch.object(github, "api", return_value={"workflow_runs": [{"status": "completed", "conclusion": conclusion}]}) as api:
                self.assertEqual(github.ci_green("exact-sha"), expected)
                self.assertIn("head_sha=exact-sha", api.call_args.args[0])
        with patch.object(github, "api", return_value={"workflow_runs": [
            {"status": "in_progress", "conclusion": None}, {"status": "completed", "conclusion": "success"},
        ]}):
            self.assertFalse(github.ci_green("exact-sha"))

    def test_draft_active_or_failed_pipeline_holds_batch(self):
        github = policy.GitHub("owner/repo")
        for status, conclusion in (("in_progress", None), ("completed", "failure"), ("completed", "cancelled")):
            with patch.object(github, "api", return_value={"workflow_runs": [{"status": status, "conclusion": conclusion}]}):
                self.assertFalse(github.idle())
        with patch.object(github, "api", return_value={"workflow_runs": []}), patch.object(github, "pages", return_value=[{"draft": True}]):
            self.assertFalse(github.idle())

    def test_merge_matches_validated_head(self):
        github = policy.GitHub("owner/repo")
        with patch.object(github, "api", return_value={"merged": True, "sha": "merged-sha"}) as api:
            github.merge({"number": 42, "title": "deps: update zod"}, "validated-sha")
            self.assertEqual(api.call_args.args[2]["sha"], "validated-sha")

    def test_only_next_patch_release_metadata_is_accepted(self):
        github = policy.GitHub("owner/repo")
        before = {
            ".release-please-manifest.json": '{".":"1.0.1"}',
            "CHANGELOG.md": "# Changelog\n\n## 1.0.1\nold notes\n",
            "app/Info.plist": "<string>1.0.1</string>",
            "daemon/package.json": '{"version":"1.0.1","dependencies":{"zod":"4.1.1"}}',
            "daemon/src/config.ts": 'export const VERSION = "1.0.1"\nexport const PORT = 123\n',
        }
        after = {path: text.replace("1.0.1", "1.0.2") for path, text in before.items()}
        after["CHANGELOG.md"] = "# Changelog\n\n## [1.0.2](compare)\npatch notes\n" + before["CHANGELOG.md"].removeprefix("# Changelog\n")
        def content(ref, path):
            return (before if ref == "base" else after)[path]
        files = [{"filename": path, "status": "modified"} for path in before]
        with patch.object(github, "compare", return_value={"files": files}), patch.object(github, "content", side_effect=content):
            self.assertTrue(policy.release_metadata_valid(github, "base", "head", "1.0.1"))
            after["daemon/src/config.ts"] += "extra code\n"
            self.assertFalse(policy.release_metadata_valid(github, "base", "head", "1.0.1"))
            after["daemon/src/config.ts"] = before["daemon/src/config.ts"].replace("1.0.1", "1.1.0")
            self.assertFalse(policy.release_metadata_valid(github, "base", "head", "1.0.1"))

    def test_release_dispatch_carries_tested_sha(self):
        github = policy.GitHub("owner/repo")
        def api(path, method="GET", payload=None):
            if method == "POST":
                self.assertEqual(payload["inputs"], {"expected_sha": "tested-sha"})
                return None
            if "event=workflow_dispatch" in path:
                return {"workflow_runs": [{"id": 2, "head_branch": "main", "head_sha": "tested-sha", "status": "completed", "conclusion": "success", "html_url": "run-url"}]}
            return {"workflow_runs": [{"id": 1}]}
        with patch.object(github, "api", side_effect=api), patch.object(github, "main_sha", return_value="tested-sha"):
            github.dispatch_wait("release.yml", "main", "tested-sha")


class BatchGitHub:
    repo = "owner/repo"

    def __init__(self, runtime=True):
        self.sha = "base"
        self.calls = []
        self.runtime = runtime
        self.failure = None
        self.move_main = False
        self.already_deployed = False
        self.pr = {"number": 42, "title": "deps: update zod", "draft": False,
                   "user": {"login": "dependabot[bot]"}, "head": {"sha": "dependency", "repo": {"full_name": self.repo}}}

    def idle(self):
        return True

    def main_sha(self):
        return self.sha

    def pages(self, path):
        if self.sha == "base":
            return [self.pr]
        return [{"number": 43, "title": "chore(main): release 1.0.2", "draft": False,
                 "user": {"login": "github-actions[bot]"},
                 "head": {"ref": policy.RELEASE_BRANCH, "sha": "release", "repo": {"full_name": self.repo}}}]

    def api(self, path):
        if path == "releases/latest":
            return {"tag_name": "v1.0.1", "immutable": True}
        if path == "releases/tags/v1.0.2":
            return {"tag_name": "v1.0.2", "immutable": True, "draft": False, "html_url": "release-url"}
        if path.startswith("actions/workflows/deploy-site.yml"):
            return {"workflow_runs": [{"head_sha": self.sha if self.already_deployed else "base", "conclusion": "success"}]}
        raise AssertionError(path)

    def safe_diff(self, base, head, neutral=False):
        return True

    def ci_green(self, sha):
        return sha != "release"

    def content(self, ref, path):
        before, _, left, right = fixture()
        if path.endswith("package.json"):
            return json.dumps(before)
        return json.dumps(right if self.runtime and ref == "batch" else left)

    def compare(self, base, head):
        return {"merge_base_commit": {"sha": base}}

    def merge(self, pr, head):
        self.calls.append(("merge", pr["number"], head))
        self.sha = "batch" if pr["number"] == 42 else "release-merge"
        return self.sha

    def dispatch_wait(self, workflow, ref, sha):
        self.calls.append((workflow, ref, sha))
        if workflow == self.failure:
            raise RuntimeError("pipeline failed")
        if self.move_main:
            self.sha = "human-change"


class BatchTests(unittest.TestCase):
    def test_read_only_run_never_mutates(self):
        github = BatchGitHub()
        policy.run(github, False)
        self.assertEqual(github.calls, [])

    def test_runtime_batch_checks_combined_main_then_release_and_deployment(self):
        github = BatchGitHub()
        with patch.object(policy, "release_metadata_valid", return_value=True):
            policy.run(github, True)
        self.assertEqual(github.calls, [
            ("merge", 42, "dependency"), ("ci.yml", "main", "batch"),
            ("deploy-site.yml", "main", "batch"), ("release.yml", "main", "batch"),
            ("ci.yml", policy.RELEASE_BRANCH, "release"), ("merge", 43, "release"),
            ("release.yml", "main", "release-merge"),
        ])

    def test_tooling_patch_does_not_cut_app_release(self):
        github = BatchGitHub(runtime=False)
        policy.run(github, True)
        self.assertEqual([call[0] for call in github.calls], ["merge", "ci.yml", "deploy-site.yml"])

    def test_failed_combined_ci_does_not_publish_or_deploy(self):
        github = BatchGitHub()
        github.failure = "ci.yml"
        with self.assertRaises(RuntimeError):
            policy.run(github, True)
        self.assertEqual([call[0] for call in github.calls], ["merge", "ci.yml"])

    def test_human_main_change_stops_release(self):
        github = BatchGitHub()
        github.move_main = True
        with self.assertRaisesRegex(RuntimeError, "Main or release state changed"):
            policy.run(github, True)
        self.assertEqual([call[0] for call in github.calls], ["merge", "ci.yml"])

    def test_failed_release_ci_does_not_merge_release_pr(self):
        github = BatchGitHub()
        original = github.dispatch_wait
        def dispatch(workflow, ref, sha):
            if ref == policy.RELEASE_BRANCH:
                raise RuntimeError("release CI failed")
            original(workflow, ref, sha)
        with patch.object(policy, "release_metadata_valid", return_value=True), patch.object(github, "dispatch_wait", side_effect=dispatch):
            with self.assertRaises(RuntimeError):
                policy.run(github, True)
        self.assertEqual([call for call in github.calls if call[0] == "merge"], [("merge", 42, "dependency")])

    def test_retry_of_deployed_site_batch_is_no_op(self):
        github = BatchGitHub(runtime=False)
        github.sha = "batch"
        github.already_deployed = True
        policy.run(github, True)
        self.assertEqual(github.calls, [])

    def test_combined_ci_still_runs_when_manual_changes_hold_release(self):
        github = BatchGitHub()
        def safe_diff(base, head, neutral=False):
            return not neutral
        with patch.object(github, "safe_diff", side_effect=safe_diff):
            policy.run(github, True)
        self.assertEqual([call[0] for call in github.calls], ["merge", "ci.yml", "deploy-site.yml"])


if __name__ == "__main__":
    unittest.main()
