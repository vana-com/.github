#!/usr/bin/env bash
# Scan changed blobs at every commit in RANGE using complete file snapshots.
# This intentionally does not use `gitleaks git`: that command scans patches,
# whose added lines omit unchanged declaration context.
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scan-commit-range.sh (--range <git-revision-range> | --include <commit> [--exclude <commit> ...]) [options]

Options:
  --repo <path>        Repository to inspect (default: current directory)
  --config <path>      Gitleaks TOML file (default: ../.gitleaks.toml)
  --gitleaks <path>    Gitleaks executable (default: gitleaks)
  --include <commit>   Commit to scan; repeatable with --exclude
  --exclude <commit>   Reachable history to exclude; repeatable with --include
USAGE
  exit 2
}

repo=$PWD
config="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.gitleaks.toml"
gitleaks=${GITLEAKS_BIN:-gitleaks}
range=''
includes=()
excludes=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --range) range=${2:-}; shift 2 ;;
    --repo) repo=${2:-}; shift 2 ;;
    --config) config=${2:-}; shift 2 ;;
    --gitleaks) gitleaks=${2:-}; shift 2 ;;
    --include) includes+=("${2:-}"); shift 2 ;;
    --exclude) excludes+=("${2:-}"); shift 2 ;;
    --help|-h) usage ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage ;;
  esac
done

if [[ -n "$range" && ${#includes[@]} -gt 0 ]] || [[ -z "$range" && ${#includes[@]} -eq 0 ]]; then
  usage
fi
[[ -f "$config" ]] || { printf 'Gitleaks config not found: %s\n' "$config" >&2; exit 2; }
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
command -v "$gitleaks" >/dev/null 2>&1 || {
  printf 'Gitleaks executable not found: %s\n' "$gitleaks" >&2
  exit 2
}

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
found=0

is_safe_relative_path() {
  local path=$1
  [[ -n "$path" && "$path" != /* && "/$path/" != *'/./'* && "/$path/" != *'/../'* && "$path" != *'//' ]]
}

commits_file="$workdir/commits"
git -C "$repo" rev-list --reverse "${revisions[@]}" >"$commits_file" || {
  printf 'Failed to enumerate commits for scanning.\n' >&2
  exit 2
}

# For each introduced commit, materialize only blobs changed by that commit.
# The complete blob, rather than its patch hunk, preserves nearby declaration
# context; the commit loop catches content later removed in the same push.
while IFS= read -r commit; do
  snapshot="$workdir/$commit"
  scan_root="$snapshot/scan"
  content="$scan_root/content"
  mkdir -p "$content"
  files=0
  paths_file="$snapshot/paths"
  git -C "$repo" diff-tree --root --no-commit-id --name-only --diff-filter=d -r -m -z "$commit" >"$paths_file" || {
    printf 'Failed to enumerate changed paths in commit %.12s.\n' "$commit" >&2
    exit 2
  }
  while IFS= read -r -d '' path; do
    is_safe_relative_path "$path" || {
      printf 'Unsafe Git path in commit %.12s; refusing to scan.\n' "$commit" >&2
      exit 2
    }
    entry_file="$snapshot/tree-entry"
    # A Git filename can begin with pathspec magic such as `:(literal)`.
    # Force literal interpretation so this exact changed blob is inspected.
    git -C "$repo" ls-tree -z "$commit" -- ":(literal)$path" >"$entry_file" || {
      printf 'Failed to inspect path %s in commit %.12s.\n' "$path" "$commit" >&2
      exit 2
    }
    IFS= read -r -d '' entry <"$entry_file" || {
      printf 'Missing tree entry for path %s in commit %.12s.\n' "$path" "$commit" >&2
      exit 2
    }
    metadata=${entry%%$'\t'*}
    read -r mode object_type object_id <<<"$metadata"
    # A gitlink is a commit reference, not superproject file content. Its
    # target repository is outside this repository's scanning boundary.
    if [[ "$mode" == 160000 && "$object_type" == commit ]]; then
      continue
    fi
    [[ "$object_type" == blob ]] || {
      printf 'Refusing to skip non-blob path %s (type %s) in commit %.12s.\n' "$path" "$object_type" "$commit" >&2
      exit 2
    }
    git -C "$repo" cat-file -e "$object_id^{blob}" 2>/dev/null || {
      printf 'Missing blob for path %s in commit %.12s.\n' "$path" "$commit" >&2
      exit 2
    }
    file="$content/$path"
    mkdir -p -- "$(dirname "$file")"
    git -C "$repo" cat-file blob "$object_id" >"$file" || {
      printf 'Failed to materialize path %s in commit %.12s.\n' "$path" "$commit" >&2
      exit 2
    }
    files=$((files + 1))
  done <"$paths_file"

  # Keep generated metadata outside `content/`: a repository may legitimately
  # contain a file named `.git-commit-message`.
  metadata="$scan_root/metadata"
  mkdir -p "$metadata"
  message_file="$metadata/commit-message.txt"
  git -C "$repo" log -1 --format=%B "$commit" >"$message_file" || {
    printf 'Failed to materialize commit message for %.12s.\n' "$commit" >&2
    exit 2
  }
  files=$((files + 1))

  [[ $files -gt 0 ]] || continue
  log="$workdir/gitleaks-$commit.log"
  set +e
  (cd "$scan_root" && "$gitleaks" dir --config "$config" --redact=100 --no-banner --no-color \
    --ignore-gitleaks-allow --log-level error --exit-code 97 .) >"$log" 2>&1
  status=$?
  set -e
  case "$status" in
    0) ;;
    97)
      printf 'Potential EVM private key detected in commit %.12s; value redacted.\n' "$commit" >&2
      found=1
      ;;
    *)
      printf 'Scanner error in commit %.12s (Gitleaks exit %s); output follows with 64-hex values redacted.\n' \
        "$commit" "$status" >&2
      sed -E 's/(0[xX])?[[:xdigit:]]{64}/[REDACTED]/g' "$log" >&2
      exit 2
      ;;
  esac
done <"$commits_file"

if [[ $found -ne 0 ]]; then
  printf 'Secret scan failed. Remove and rotate the value; removing it in a later commit is insufficient.\n' >&2
  exit 1
fi
