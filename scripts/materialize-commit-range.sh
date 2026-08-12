#!/usr/bin/env bash
# Materialize complete changed blobs and commit messages for immutable Git commits.
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: materialize-commit-range.sh (--range <git-revision-range> | --include <commit> [--exclude <commit> ...]) --output <directory> [--repo <path>]

Options:
  --repo <path>        Repository to inspect (default: current directory)
  --output <directory> Empty directory to receive immutable snapshots
  --include <commit>   Commit to scan; repeatable with --exclude
  --exclude <commit>   Reachable history to exclude; repeatable with --include
USAGE
  exit 2
}

repo=$PWD
output=''
range=''
includes=()
excludes=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --range) range=${2:-}; shift 2 ;;
    --repo) repo=${2:-}; shift 2 ;;
    --output) output=${2:-}; shift 2 ;;
    --include) includes+=("${2:-}"); shift 2 ;;
    --exclude) excludes+=("${2:-}"); shift 2 ;;
    --help|-h) usage ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage ;;
  esac
done

if [[ -z "$output" ]] || { [[ -n "$range" ]] && [[ ${#includes[@]} -gt 0 ]]; } || { [[ -z "$range" ]] && [[ ${#includes[@]} -eq 0 ]]; }; then
  usage
fi
[[ ! -e "$output" ]] || { printf 'Output directory already exists: %s\n' "$output" >&2; exit 2; }
git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  printf 'Not a Git work tree: %s\n' "$repo" >&2
  exit 2
}
if [[ -n "$range" ]]; then
  revisions=("$range")
else
  revisions=("${includes[@]}")
  if [[ ${#excludes[@]} -gt 0 ]]; then
    revisions+=(--not "${excludes[@]}")
  fi
fi
git -C "$repo" rev-list --quiet "${revisions[@]}" >/dev/null 2>&1 || {
  printf 'Invalid or unavailable revisions.\n' >&2
  exit 2
}

is_safe_relative_path() {
  local path=$1
  [[ -n "$path" && "$path" != /* && "/$path/" != *'/./'* && "/$path/" != *'/../'* && "$path" != *'//' ]]
}

mkdir -p "$output/commits"
commits_file="$output/commits.txt"
git -C "$repo" rev-list --reverse "${revisions[@]}" >"$commits_file" || {
  printf 'Failed to enumerate commits for materialization.\n' >&2
  rm -rf "$output"
  exit 2
}

while IFS= read -r commit; do
  snapshot="$output/commits/$commit"
  scan_root="$snapshot/scan"
  content="$scan_root/content"
  metadata="$scan_root/metadata"
  mkdir -p "$content" "$metadata"
  paths_file="$snapshot/paths"
  git -C "$repo" diff-tree --root --no-commit-id --name-only --diff-filter=d -r -m -z "$commit" >"$paths_file" || {
    printf 'Failed to enumerate changed paths in commit %.12s.\n' "$commit" >&2
    exit 2
  }
  while IFS= read -r -d '' path; do
    is_safe_relative_path "$path" || {
      printf 'Unsafe Git path in commit %.12s; refusing to materialize.\n' "$commit" >&2
      exit 2
    }
    entry_file="$snapshot/tree-entry"
    git -C "$repo" ls-tree -z "$commit" -- ":(literal)$path" >"$entry_file" || {
      printf 'Failed to inspect changed path in commit %.12s.\n' "$commit" >&2
      exit 2
    }
    IFS= read -r -d '' entry <"$entry_file" || {
      printf 'Missing tree entry in commit %.12s.\n' "$commit" >&2
      exit 2
    }
    metadata_entry=${entry%%$'\t'*}
    read -r mode object_type object_id <<<"$metadata_entry"
    if [[ "$mode" == 160000 && "$object_type" == commit ]]; then
      continue
    fi
    [[ "$object_type" == blob ]] || {
      printf 'Refusing to skip non-blob path in commit %.12s.\n' "$commit" >&2
      exit 2
    }
    git -C "$repo" cat-file -e "$object_id^{blob}" 2>/dev/null || {
      printf 'Missing selected blob in commit %.12s.\n' "$commit" >&2
      exit 2
    }
    file="$content/$path"
    mkdir -p -- "$(dirname "$file")"
    git -C "$repo" cat-file blob "$object_id" >"$file" || {
      printf 'Failed to materialize changed blob in commit %.12s.\n' "$commit" >&2
      exit 2
    }
  done <"$paths_file"
  git -C "$repo" log -1 --format=%B "$commit" >"$metadata/commit-message.txt" || {
    printf 'Failed to materialize commit message for %.12s.\n' "$commit" >&2
    exit 2
  }
done <"$commits_file"
