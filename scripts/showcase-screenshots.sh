#!/usr/bin/env bash
# The real UI with local demo data, captured through the e2e harness (scripts/e2e.sh): the
# debug app on its own static mock daemon, at a free port, drawn off screen with the Keychain
# in memory. Never attaches to a live daemon. Every screen in app/E2E/showcase.json lands in
# site/src/assets/app/ (the landing page and the launch film), and two of them in docs/images/
# (the README).
set -euo pipefail

cd "$(dirname "$0")/.."
status=0
SUITE=app/E2E/showcase.json BASELINE= scripts/e2e.sh || status=$?
# 1 only means the layout lint found something, which a screenshot does not wait on.
if [ "$status" -gt 1 ]; then exit "$status"; fi
run=".context/e2e/$(readlink .context/e2e/latest)"

mkdir -p site/src/assets/app
for shot in "$run"/shots/*.dark.png; do
  cp "$shot" "site/src/assets/app/$(basename "$shot" .dark.png).png"
done
# A phone's hero (site/src/components/Hero.astro): the middle column alone, what needs you.
(cd site && bun -e 'await (await import("sharp")).default("src/assets/app/tall-overview.png").extract({ left: 762, top: 65, width: 718, height: 1513 }).toFile("src/assets/app/needs-you.png")')
cp "$run/shots/overview.dark.png" docs/images/bridgetown-overview.png
cp "$run/shots/session-merge.dark.png" docs/images/bridgetown-session.png
echo "Captured $(ls "$run"/shots/*.dark.png | wc -l | tr -d ' ') screens into site/src/assets/app and the README's two into docs/images"
