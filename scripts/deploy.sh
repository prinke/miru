#!/usr/bin/env bash
# Deploys the current commit to Dokku together with the private premium/
# module, which is gitignored and so never part of a normal `git push`.
#
# The premium code is committed only in a throwaway detached worktree that is
# pushed to Dokku and then removed, so it never lands on a branch that could
# be pushed to the public repository.
#
#   scripts/deploy.sh [remote]     (remote defaults to "dokku")

set -euo pipefail

remote="${1:-dokku}"
root="$(git rev-parse --show-toplevel)"

if [ ! -f "$root/premium/index.js" ]; then
  echo "premium/index.js not found — use a plain 'git push $remote master' to deploy without premium." >&2
  exit 1
fi

if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "Note: uncommitted changes in the public code are not deployed (deploying HEAD)." >&2
fi

tmp="$(mktemp -d)"
cleanup() { git -C "$root" worktree remove --force "$tmp" >/dev/null 2>&1 || rm -rf "$tmp"; }
trap cleanup EXIT

git -C "$root" worktree add --quiet --detach "$tmp" HEAD
rsync -a --exclude .git --exclude node_modules "$root/premium/" "$tmp/premium/"
git -C "$tmp" add --force premium
git -C "$tmp" commit --quiet --no-verify -m "Deploy $(git -C "$root" rev-parse --short HEAD) with premium"
git -C "$tmp" push --force "$remote" HEAD:refs/heads/master
