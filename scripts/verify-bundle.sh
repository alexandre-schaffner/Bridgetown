#!/usr/bin/env sh
# Checks what `make all dmg` produced before anyone downloads it: the daemon is inside, the
# signature holds, the image reads back, the app carries the key updates are checked against,
# and (with EXPECTED_VERSION) the app says the version it is being released as.

set -eu

cd "$(dirname "$0")/.."

app="build/Bridgetown.app"
dmg="build/Bridgetown.dmg"
plist="$app/Contents/Info.plist"

test -x "$app/Contents/Resources/bridgetown-daemon" || { echo "daemon not bundled in $app" >&2; exit 1; }
codesign --verify --deep --strict "$app"
hdiutil verify -quiet "$dmg"

keys=0
while key=$(/usr/libexec/PlistBuddy -c "Print :BridgetownUpdatePublicKeys:$keys" "$plist" 2>/dev/null); do
  [ "$(printf '%s' "$key" | base64 -D 2>/dev/null | wc -c | tr -d ' ')" = 32 ] || { echo "BridgetownUpdatePublicKeys:$keys in $plist isn't an Ed25519 key" >&2; exit 1; }
  keys=$((keys + 1))
done
[ "$keys" -gt 0 ] || { echo "no BridgetownUpdatePublicKeys in $plist" >&2; exit 1; }

version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$plist")
build=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$plist")
if [ -n "${EXPECTED_VERSION:-}" ] && [ "$version" != "$EXPECTED_VERSION" ]; then
  echo "Info.plist says $version, releasing $EXPECTED_VERSION" >&2
  exit 1
fi

echo "ok: Bridgetown $version ($build), $(du -h "$dmg" | awk '{print $1}') dmg"
