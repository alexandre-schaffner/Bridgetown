#!/bin/sh
# make e2e: the debug app on the static mock daemon, every screen in app/E2E/suite.json
# photographed and linted, into .context/e2e/<UTC time>/ (`latest` points at it):
# shots/*.png, issues/*.png (a crop per issue), diff/*.png, report.json, index.md, and the
# app's and daemon's logs. Exits as the app does: 0 clean, 1 lint errors, 2 harness failure.
#
#   ONLY='overview*'      only the shots whose names match (every step still runs)
#   SUITE=path.json|none  another suite, or none (with SERVE=1: straight to serving)
#   BASELINE=<run dir>    diff against that run (default: the previous `latest`; empty: none)
#   SERVE=1               then stay up for an agent: see <run>/control.json for url and token
set -eu
cd "$(dirname "$0")/.."
ROOT=$PWD
E2E=.context/e2e
mkdir -p "$E2E"

# One run at a time in a checkout; a lock whose owner died is taken over.
if ! mkdir "$E2E/.lock" 2>/dev/null; then
  owner=$(cat "$E2E/.lock/pid" 2>/dev/null || echo "")
  if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
    echo "e2e: run $owner is still going ($E2E/.lock)" >&2
    exit 2
  fi
  rm -rf "$E2E/.lock" && mkdir "$E2E/.lock"
fi
echo $$ > "$E2E/.lock/pid"
trap 'rm -rf "$ROOT/$E2E/.lock"' EXIT

swift build --package-path app
BIN="$(swift build --package-path app --show-bin-path)/Bridgetown"

RUN="$E2E/$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$RUN"
if [ -z "${BASELINE+set}" ] && [ -d "$E2E/latest/shots" ]; then BASELINE="$E2E/$(readlink "$E2E/latest")"; fi
# From the start, so a served run is found at .context/e2e/latest/control.json.
ln -sfn "$(basename "$RUN")" "$E2E/latest"
echo "e2e: $RUN${SERVE:+ (serving: $RUN/control.json has the url and token once it is up)}"
# This checkout's own port in 47700-48699, so shots that print it compare from run to run;
# any free one when it is taken. Never the real daemon's 47621.
PORT=$(bun -e '
const free = (port) => { try { const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); const p = s.port; s.stop(true); return p } catch { return undefined } }
console.log(free(47700 + (Number(process.argv[1]) % 1000)) ?? free(0))' "$(printf %s "$ROOT" | cksum | cut -d' ' -f1)")
# Serving waits on its agent (the app's own idle watchdog ends it); a suite run gets 15 minutes.
ALARM=900
if [ -n "${SERVE:-}" ]; then ALARM=0; fi

status=0
# The app sets the rest of the mock's environment itself (E2EHarness.configure), whatever this shell has.
env BRIDGETOWN_DAEMON_CMD="bun $ROOT/daemon/scripts/mock/main.ts" BRIDGETOWN_PORT="$PORT" BRIDGETOWN_LOG_DIR="$ROOT/$RUN" \
  E2E_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" TZ=UTC \
  perl -e 'alarm shift; exec @ARGV' "$ALARM" "$BIN" -AppleLocale en_US -AppleLanguages '(en)' \
  --e2e "${SUITE:-app/E2E/suite.json}" --e2e-out "$RUN" \
  ${ONLY:+--e2e-only "$ONLY"} ${BASELINE:+--e2e-baseline "$BASELINE"} ${SERVE:+--e2e-serve} \
  2>"$RUN/app.log" || status=$?

# The newest five runs stay.
ls -1d "$E2E"/2*/ 2>/dev/null | sort -r | tail -n +6 | while read -r old; do rm -rf "$old"; done
echo "e2e: $RUN/index.md (exit $status)"
sed -n 3p "$RUN/index.md" 2>/dev/null || true
exit "$status"
