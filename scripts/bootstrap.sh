#!/usr/bin/env bash
# Central bootstrap for the EVM key-scan pre-push hook.
#
# Consuming repositories ship a thin stub that fetches this policy checkout at a
# pinned SHA and execs this script. Everything below is therefore maintained in
# one place: a fix here reaches every repository when it advances its pin, and
# no consumer carries a copy that can drift.
#
# The stub is responsible for exactly two things — naming the pinned SHA (the
# supply-chain review gate) and getting this checkout onto disk. This script
# owns validation, locking, and delegation to the installer.
set -euo pipefail

readonly CENTRAL_REPOSITORY='https://github.com/vana-com/.github.git'

policy_sha=${VANA_POLICY_SHA:-}
[[ "$policy_sha" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'bootstrap.sh requires VANA_POLICY_SHA to be a 40-character commit SHA.\n' >&2
  exit 2
}

action=${1:-install}
case "$action" in
  install|status|uninstall) shift || true ;;
  *)
    printf 'Usage: bootstrap.sh [install|status|uninstall]\n' >&2
    exit 2
    ;;
esac

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

# The pushing repository is discovered with the INHERITED environment: that is
# exactly what this call wants, unlike every policy-cache command below.
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'Run this from a Git work tree.'

cache_root="${XDG_DATA_HOME:-$HOME/.local/share}/vana-secret-scan/policy"
policy_dir="$cache_root/$policy_sha"
lock_dir="$cache_root/.${policy_sha}.lock"
tmp_dir=''

# Git exports GIT_DIR (and friends) into hook processes. In a linked worktree
# that value is an ABSOLUTE path, so a plain `git -C "$policy_dir" ...` still
# resolves against the pushing repository and reports ITS remote, HEAD and
# status instead of the policy cache's — validation then rejects a perfectly
# good cache with "unexpected policy-cache origin". (In a normal checkout
# GIT_DIR is the relative ".git", which happens to resolve correctly under -C,
# which is why this only bites worktrees.)
#
# The scrub list comes from git itself rather than a hardcoded set: it covers
# the directory variables, the repository-local variables (GIT_SHALLOW_FILE,
# GIT_GRAFT_FILE, GIT_REPLACE_REF_BASE, GIT_IMPLICIT_WORK_TREE) and
# GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT (which `git -c foo=bar push` exports
# into hooks). The GIT_CONFIG_* FILE overrides are not in that list, so they are
# added explicitly — without GIT_CONFIG_GLOBAL a caller can point
# `remote.origin.url` at vana-com/.github from its own environment and satisfy
# the origin check against a cache whose real origin is something else.
# A hardcoded fallback covers a git too old to answer.
policy_git() {
  local scrub=()
  local v
  while IFS= read -r v; do
    [[ -n "$v" ]] && scrub+=(-u "$v")
  done < <(git rev-parse --local-env-vars 2>/dev/null || printf '%s\n' \
    GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR \
    GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT)
  for v in GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM; do
    scrub+=(-u "$v")
  done
  env "${scrub[@]}" git "$@"
}

cleanup() {
  [[ -z "$tmp_dir" ]] || rm -rf "$tmp_dir"
  rmdir "$lock_dir" 2>/dev/null || true
}

mkdir -p "$cache_root"
mkdir "$lock_dir" 2>/dev/null || fail "Policy setup is already running; try again: $lock_dir"
trap cleanup EXIT

[[ ! -L "$policy_dir" ]] || fail "Refusing symlinked policy cache: $policy_dir"
if [[ -d "$policy_dir/.git" ]]; then
  origin=$(policy_git -C "$policy_dir" remote get-url origin) || fail "Refusing unreadable policy cache: $policy_dir"
  case "$origin" in
    "$CENTRAL_REPOSITORY"|https://github.com/vana-com/.github|git@github.com:vana-com/.github|git@github.com:vana-com/.github.git) ;;
    *) fail "Refusing unexpected policy-cache origin: $policy_dir" ;;
  esac
  [[ "$(policy_git -C "$policy_dir" rev-parse HEAD)" == "$policy_sha" ]] || fail "Refusing stale policy cache: $policy_dir"
  [[ -z "$(policy_git -C "$policy_dir" status --porcelain --untracked-files=all -- ':!/.tools')" ]] || fail "Refusing modified policy cache: $policy_dir"
else
  [[ ! -e "$policy_dir" ]] || fail "Refusing invalid policy cache: $policy_dir"
  tmp_dir=$(mktemp -d "$cache_root/.policy.XXXXXX")
  policy_git init -q "$tmp_dir"
  policy_git -C "$tmp_dir" remote add origin "$CENTRAL_REPOSITORY"
  policy_git -C "$tmp_dir" fetch --depth 1 origin "$policy_sha"
  policy_git -C "$tmp_dir" checkout -q --detach FETCH_HEAD
  [[ "$(policy_git -C "$tmp_dir" rev-parse HEAD)" == "$policy_sha" ]] || fail 'Fetched policy does not match requested SHA.'
  mv "$tmp_dir" "$policy_dir"
  tmp_dir=''
fi

if [[ "$action" == install ]]; then
  "$policy_dir/scripts/install-pre-push.sh" prepare \
    --shared-dir "$policy_dir" \
    --repo "$repo_root" \
    --ref "$policy_sha"
fi

rmdir "$lock_dir"
trap - EXIT
exec "$policy_dir/scripts/install-pre-push.sh" "$action" \
  --shared-dir "$policy_dir" \
  --repo "$repo_root" \
  --ref "$policy_sha" "$@"
