#!/usr/bin/env bash
# Capture the real UI with local demo data through the e2e harness (scripts/e2e.sh): the
# debug app on its own static mock daemon, at a free port, drawn off screen with the
# Keychain in memory. Never attaches to a live daemon.
set -euo pipefail

cd "$(dirname "$0")/.."
capture_dir="$PWD/.context/readme"
mkdir -p "$capture_dir"

# The overview and the s_mock_merge session at the real 480-point open height (`wide`).
suite="$capture_dir/suite.json"
cat > "$suite" <<'JSON'
{
  "now": "2026-10-04T12:00:00Z",
  "world": "full",
  "appearances": ["dark"],
  "steps": [
    {"surface": "open", "preset": "wide"},
    {"shot": "overview"},
    {"show": {"session": "s_mock_merge"}},
    {"shot": "session"}
  ]
}
JSON

status=0
SUITE="$suite" BASELINE= scripts/e2e.sh || status=$?
# 1 only means the layout lint found something, which a screenshot does not wait on.
if [ "$status" -gt 1 ]; then exit "$status"; fi
run=".context/e2e/$(readlink .context/e2e/latest)"
cp "$run/shots/overview.dark.png" "$capture_dir/overview.png"
cp "$run/shots/session.dark.png" "$capture_dir/session.png"
echo "Captured overview.png and session.png in $capture_dir"
