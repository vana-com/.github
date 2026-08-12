#!/usr/bin/env bash
# Scan immutable changed-blob snapshots at every commit in RANGE.
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
materializer="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/materialize-commit-range.sh"
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
materializer_args=(--repo "$repo" --output "$workdir/materialized")
if [[ -n "$range" ]]; then
  materializer_args+=(--range "$range")
else
  for include in "${includes[@]}"; do
    materializer_args+=(--include "$include")
  done
  for exclude in "${excludes[@]}"; do
    materializer_args+=(--exclude "$exclude")
  done
fi
"$materializer" "${materializer_args[@]}"

while IFS= read -r commit; do
  snapshot="$workdir/materialized/commits/$commit"
  scan_root="$snapshot/scan"
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
done <"$workdir/materialized/commits.txt"

if [[ $found -ne 0 ]]; then
  printf 'Secret scan failed. Remove and rotate the value; removing it in a later commit is insufficient.\n' >&2
  exit 1
fi
