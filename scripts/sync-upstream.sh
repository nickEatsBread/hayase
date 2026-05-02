#!/usr/bin/env bash
# Pull updates from a hayase-app upstream into our monorepo.
#
# Usage:
#   scripts/sync-upstream.sh <package>      # one of: electron, interface, torrent-client, native, wiki, capacitor, free-torrents
#   scripts/sync-upstream.sh all            # try all of them
#
# Each package directory in the monorepo mirrors a separate hayase-app repo.
# We track those upstreams as `upstream-<package>` remotes and use git's
# subtree merge strategy (-X subtree=<path>) to remap upstream changes onto
# the corresponding subdirectory.
#
# Conflicts will halt the merge - resolve, `git add`, then `git commit`.

set -euo pipefail

PACKAGES=(electron interface torrent-client native wiki capacitor free-torrents)

usage () {
  echo "Usage: $0 <package|all>" >&2
  echo "Available packages: ${PACKAGES[*]}" >&2
  exit 64
}

if [[ $# -ne 1 ]]; then usage; fi

sync_one () {
  local pkg="$1"
  local remote="upstream-${pkg}"
  local branch="main"

  if ! git remote get-url "$remote" >/dev/null 2>&1; then
    echo "ERROR: remote '$remote' is not configured. Run scripts/setup-remotes.sh first." >&2
    return 1
  fi

  echo
  echo "==> Syncing $pkg from $remote/$branch"

  # Some upstreams may use master rather than main - try main first then fall back.
  if ! git fetch "$remote" "$branch" 2>/dev/null; then
    branch="master"
    git fetch "$remote" "$branch"
  fi

  # The first time we sync a given upstream we need --allow-unrelated-histories
  # because the monorepo's initial commit has no relation to the upstream.
  # Subsequent syncs reuse the same merge base and don't need it.
  local extra_flags=""
  if ! git merge-base HEAD "$remote/$branch" >/dev/null 2>&1; then
    extra_flags="--allow-unrelated-histories"
  fi

  if git merge --squash -X "subtree=${pkg}" $extra_flags "$remote/$branch"; then
    if git diff --cached --quiet; then
      echo "    Already up to date - no changes from $remote/$branch."
    else
      git commit -m "sync ${pkg} from upstream

Pulled from ${remote}/${branch}."
      echo "    Committed sync for $pkg."
    fi
  else
    echo "    Merge produced conflicts. Resolve them, run \`git add <files>\`, then:" >&2
    echo "      git commit -m 'sync ${pkg} from upstream'" >&2
    return 1
  fi
}

if [[ "$1" == "all" ]]; then
  for pkg in "${PACKAGES[@]}"; do
    sync_one "$pkg" || echo "  -> $pkg sync failed; continuing with the rest."
  done
else
  match="$1"
  found=0
  for pkg in "${PACKAGES[@]}"; do
    if [[ "$pkg" == "$match" ]]; then found=1; fi
  done
  if [[ $found -eq 0 ]]; then usage; fi
  sync_one "$match"
fi
