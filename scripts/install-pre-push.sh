#!/usr/bin/env bash
# Install the optional hook without overwriting another tool's pre-push hook.
set -euo pipefail

usage() {
  printf 'Usage: %s --shared-dir <trusted scanner checkout> [--repo <repository>]\n' "${0##*/}" >&2
  exit 2
}

repo=$PWD
shared_dir=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo=${2:-}; shift 2 ;;
    --shared-dir) shared_dir=${2:-}; shift 2 ;;
    --help|-h) usage ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage ;;
  esac
done
[[ -n "$shared_dir" ]] || usage
git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || { printf 'Not a Git work tree: %s\n' "$repo" >&2; exit 2; }
repo=$(cd "$repo" && pwd -P)
[[ -x "$shared_dir/hooks/pre-push" ]] || { printf 'No hook at: %s/hooks/pre-push\n' "$shared_dir" >&2; exit 2; }
shared_dir=$(cd "$shared_dir" && pwd -P)

hooks_dir=$(git -C "$repo" rev-parse --git-path hooks)
[[ "$hooks_dir" = /* ]] || hooks_dir="$repo/$hooks_dir"
hook="$hooks_dir/pre-push"
if [[ -e "$hook" ]]; then
  printf 'Refusing to overwrite existing hook: %s\nMerge it manually or use your hook manager.\n' "$hook" >&2
  exit 2
fi

mkdir -p "$hooks_dir"
printf '#!/usr/bin/env bash\nexec env VANA_SECRET_SCAN_HOME=%q %q "$@"\n' \
  "$shared_dir" "$shared_dir/hooks/pre-push" >"$hook"
chmod 0755 "$hook"
printf 'Installed optional pre-push guard at %s\n' "$hook"
