#!/usr/bin/env sh

set -eu

cd "$(dirname "$0")/.."

repo_dir=".repos/effect"
repo_url="https://github.com/Effect-TS/effect"

if [ -d "$repo_dir/.git" ]; then
  exit 0
fi

mkdir -p ".repos"
git clone "$repo_url" "$repo_dir"
