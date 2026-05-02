#!/usr/bin/env bash
# One-time setup: register all hayase-app upstream remotes so
# scripts/sync-upstream.sh can pull updates.
#
# Idempotent - safe to run after a fresh clone.

set -euo pipefail

declare -A REMOTES=(
  [upstream-electron]=https://github.com/hayase-app/electron.git
  [upstream-interface]=https://github.com/hayase-app/interface.git
  [upstream-torrent-client]=https://github.com/hayase-app/torrent-client.git
  [upstream-native]=https://github.com/hayase-app/native.git
  [upstream-wiki]=https://github.com/hayase-app/wiki.git
  [upstream-capacitor]=https://github.com/hayase-app/capacitor.git
  [upstream-free-torrents]=https://github.com/hayase-app/free-torrents.git
)

for name in "${!REMOTES[@]}"; do
  url="${REMOTES[$name]}"
  if git remote get-url "$name" >/dev/null 2>&1; then
    git remote set-url "$name" "$url"
    echo "updated $name -> $url"
  else
    git remote add "$name" "$url"
    echo "added   $name -> $url"
  fi
done

echo
echo "Remotes:"
git remote -v
