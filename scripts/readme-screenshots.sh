#!/usr/bin/env bash
# Capture the real UI with local demo data; never attaches to a live daemon.
set -euo pipefail

cd "$(dirname "$0")/.."
capture_dir="$PWD/.context/readme"
capture_port="${BRIDGETOWN_SCREENSHOT_PORT:-47653}"
mkdir -p "$capture_dir"

swift build --package-path app
capture_binary="$(swift build --package-path app --show-bin-path)/Bridgetown"

BRIDGETOWN_PORT="$capture_port" BRIDGETOWN_API_TOKEN=dev MOCK_GRAFANA=mock \
  bun daemon/scripts/mock/main.ts > "$capture_dir/mock.log" 2>&1 &
capture_pid=$!
trap 'kill "$capture_pid" 2>/dev/null || true; wait "$capture_pid" 2>/dev/null || true' EXIT

capture_ready=false
for ((attempt = 0; attempt < 50; attempt++)); do
  if ! kill -0 "$capture_pid" 2>/dev/null; then
    cat "$capture_dir/mock.log" >&2
    exit 1
  fi
  if grep -q 'mock bridgetown daemon on' "$capture_dir/mock.log"; then
    capture_ready=true
    break
  fi
  sleep 0.1
done
if [ "$capture_ready" != true ]; then
  cat "$capture_dir/mock.log" >&2
  exit 1
fi

capture() {
  local name="$1"
  local capture_path="$capture_dir/.$name-$$.png"
  shift
  BRIDGETOWN_ATTACH=1 BRIDGETOWN_API_TOKEN=dev BRIDGETOWN_PORT="$capture_port" \
    "$capture_binary" --preview-island --preview-height 480 --appearance dark \
    --snapshot "$capture_path" --snapshot-quit "$@"
  test -s "$capture_path"
  mv "$capture_path" "$capture_dir/$name.png"
}

capture overview
capture session --preview-detail s_mock_merge
echo "Captured overview.png and session.png in $capture_dir"
