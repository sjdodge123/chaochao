#!/usr/bin/env bash
#
# setup-git.sh — configure your local clone for the chaochao dev workflow.
#
# Workflow this supports: develop each feature in its own isolated git worktree,
# aggregate several in-flight features onto the `localhostplaytest` branch to demo
# the combined build, then ship each feature independently via its own PR to main.
#
# Everything here is written to THIS clone's .git/config (plus a local
# git-maintenance schedule). Nothing is committed or shared — re-run after a fresh
# clone or on a new machine. Safe and idempotent to re-run at any time.
#
# Usage:  ./scripts/setup-git.sh        (run from anywhere inside the clone)

set -euo pipefail

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: run this from inside the chaochao git clone." >&2
  exit 1
fi

echo "==> Keep local main effortlessly current"
# fetch prunes deleted remote-tracking refs; rerere replays conflict resolutions
# (so repeatedly merging features into the playtest branch stops re-asking).
git config fetch.prune true
git config rerere.enabled true
git config rerere.autoupdate true
# `git sync-main` fast-forwards local main from any branch (main never has its own
# commits — it just lags origin/main because PRs merge on GitHub and nobody pulls).
# shellcheck disable=SC2016  # single quotes are intentional: git evaluates the alias, not this script
git config alias.sync-main '!b=$(git symbolic-ref --short HEAD 2>/dev/null); if [ "$b" = main ]; then git pull --ff-only; else git fetch origin main:main; fi'

echo "==> Background maintenance (scheduled prefetch/gc)"
git maintenance start 2>/dev/null || echo "   (git maintenance start unavailable; skipping)"

echo "==> Playtest aggregation aliases (run these from the localhostplaytest worktree)"
# `git playtest-rebuild <featA> <featB> ...` — reset playtest to origin/main, then
# sequentially merge the listed feature branches. rerere replays repeat conflicts.
# shellcheck disable=SC2016  # single quotes are intentional: git evaluates the alias, not this script
git config alias.playtest-rebuild '!f() { br=$(git rev-parse --abbrev-ref HEAD); if [ "$br" != localhostplaytest ]; then echo "run from the localhostplaytest worktree (currently on $br)"; return 1; fi; if [ $# -eq 0 ]; then echo "usage: git playtest-rebuild <feature-branch>..."; return 1; fi; if [ -n "$(git status --porcelain)" ]; then echo "playtest worktree is dirty — commit or stash first"; return 1; fi; git fetch origin && git reset --hard origin/main || return 1; for b in "$@"; do echo ">> merging $b"; git merge --no-ff --no-edit "$b" || { echo "CONFLICT on $b — resolve, commit, then re-run with the remaining branches"; return 1; }; done; echo "playtest rebuilt: origin/main + $*"; }; f'
# `git playtest-add <featC>` — tack one more feature onto the current playtest.
# shellcheck disable=SC2016  # single quotes are intentional: git evaluates the alias, not this script
git config alias.playtest-add '!f() { br=$(git rev-parse --abbrev-ref HEAD); if [ "$br" != localhostplaytest ]; then echo "run from the localhostplaytest worktree (currently on $br)"; return 1; fi; if [ $# -eq 0 ]; then echo "usage: git playtest-add <feature-branch>..."; return 1; fi; for b in "$@"; do echo ">> merging $b"; git merge --no-ff --no-edit "$b" || { echo "CONFLICT on $b — resolve & commit"; return 1; }; done; }; f'

echo "==> git-town (per-feature: hack -> sync -> propose -> ship to main)"
if ! command -v git-town >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "   installing git-town via Homebrew..."
    brew install git-town
  else
    echo "   git-town not found and Homebrew unavailable."
    echo "   install it manually, then re-run: https://www.git-town.com/install"
  fi
fi
if command -v git-town >/dev/null 2>&1; then
  git config git-town.main-branch main
  git config git-town.sync-feature-strategy rebase   # clean linear diffs for independent PRs
  git config git-town.forge-type github
  # Park the playtest aggregation branch so `git town sync`/`ship` skip it — it is
  # managed by the playtest-rebuild/playtest-add aliases above, not by git-town.
  if git show-ref --verify --quiet refs/heads/localhostplaytest; then
    git town park localhostplaytest >/dev/null 2>&1 \
      || git config git-town-branch.localhostplaytest.branchtype parked
  fi
fi

echo
echo "Done. Quick check:  git sync-main"
