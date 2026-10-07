#!/usr/bin/env sh
# Effect's sources in .repos/effect, for agents to read: the release the daemon installs,
# not whatever main holds today. The daemon's `prepare` runs this on every `bun install`,
# so it clones once (shallow, one tag) and never fails the install: offline, it warns and
# carries on, since the sources are reference only.

set -u

cd "$(dirname "$0")/.."

repo_dir=".repos/effect"
repo_url="https://github.com/Effect-TS/effect"
# The exact version daemon/package.json pins, e.g. "effect": "4.0.0".
version=$(sed -n 's/^ *"effect": *"\([0-9][^"]*\)".*/\1/p' daemon/package.json)
if [ -z "$version" ]; then
  echo "warning: no pinned effect version in daemon/package.json; not cloning Effect's sources" >&2
  exit 0
fi
tag="effect@$version"

if [ -d "$repo_dir/.git" ]; then
  if ! git -C "$repo_dir" tag --points-at HEAD 2>/dev/null | grep -qx "$tag"; then
    echo "warning: $repo_dir is not at $tag, the version the daemon installs; delete it and run bun install again to fetch that one" >&2
  fi
  exit 0
fi

mkdir -p ".repos"
if ! git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "$repo_url" "$repo_dir"; then
  rm -rf "$repo_dir"
  echo "warning: could not clone $tag into $repo_dir (offline?); Effect's sources are reference only, so the install carries on" >&2
fi
exit 0
