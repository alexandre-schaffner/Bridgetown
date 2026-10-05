#!/usr/bin/env sh
# Checks what `make all dmg` produced before anyone downloads it: the daemon is inside, the
# signature holds, the image reads back, and (with EXPECTED_VERSION) the app says the version
# it is being released as.

set -eu

cd "$(dirname "$0")/.."

app="build/Bridgetown.app"
dmg="build/Bridgetown.dmg"
plist="$app/Contents/Info.plist"

test -x "$app/Contents/Resources/bridgetown-daemon" || { echo "daemon not bundled in $app" >&2; exit 1; }
codesign --verify --deep --strict "$app"
hdiutil verify -quiet "$dmg"

version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$plist")
build=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$plist")
if [ -n "${EXPECTED_VERSION:-}" ] && [ "$version" != "$EXPECTED_VERSION" ]; then
  echo "Info.plist says $version, releasing $EXPECTED_VERSION" >&2
  exit 1
fi

echo "ok: Bridgetown $version ($build), $(du -h "$dmg" | awk '{print $1}') dmg"
