#!/usr/bin/env bash
# Install the optional hook without overwriting another tool's pre-push hook.
set -euo pipefail

usage() {
  cat >&2 <<USAGE
Usage: ${0##*/} [install|status|uninstall] [options]

Options:
  --repo <repository>       Git repository to manage (default: current directory)
  --shared-dir <checkout>   Trusted vana-com/.github checkout (default: this checkout)
  --ref <sha>              Required 40-character policy commit

The installer writes only a small managed launcher. It refuses to overwrite an
unmanaged pre-push hook.
USAGE
  exit 2
}

command_name=install
repo=$PWD
shared_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
expected_sha=''
if [[ $# -gt 0 && "$1" != --* ]]; then
  command_name=$1
  shift
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo=${2:-}; shift 2 ;;
    --shared-dir) shared_dir=${2:-}; shift 2 ;;
    --ref|--expected-sha) expected_sha=${2:-}; shift 2 ;;
    --help|-h) usage ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage ;;
  esac
done
case "$command_name" in
  install|status|uninstall) ;;
  *) printf 'Unknown command: %s\n' "$command_name" >&2; usage ;;
esac
git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || { printf 'Not a Git work tree: %s\n' "$repo" >&2; exit 2; }
repo=$(cd "$repo" && pwd -P)
[[ -x "$shared_dir/hooks/pre-push" ]] || { printf 'No hook at: %s/hooks/pre-push\n' "$shared_dir" >&2; exit 2; }
shared_dir=$(cd "$shared_dir" && pwd -P)
if [[ -z "$expected_sha" ]]; then
  expected_sha=$(git -C "$shared_dir" rev-parse HEAD)
fi
[[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'Expected policy SHA must be a 40-character lowercase commit ID.\n' >&2
  exit 2
}
actual_sha=$(git -C "$shared_dir" rev-parse HEAD)
[[ "$actual_sha" == "$expected_sha" ]] || {
  printf 'Policy checkout is at %s, expected %s.\n' "$actual_sha" "$expected_sha" >&2
  exit 2
}
origin_url=$(git -C "$shared_dir" config --get remote.origin.url || true)
case "$origin_url" in
  git@github.com:vana-com/.github.git|https://github.com/vana-com/.github.git) ;;
  *) printf 'Policy checkout origin is not vana-com/.github: %s\n' "${origin_url:-<unset>}" >&2; exit 2 ;;
esac
git -C "$shared_dir" diff --quiet -- . || {
  printf 'Policy checkout has unstaged changes: %s\n' "$shared_dir" >&2
  exit 2
}
git -C "$shared_dir" diff --cached --quiet -- . || {
  printf 'Policy checkout has staged changes: %s\n' "$shared_dir" >&2
  exit 2
}

hooks_dir=$(git -C "$repo" rev-parse --git-path hooks)
[[ "$hooks_dir" = /* ]] || hooks_dir="$repo/$hooks_dir"
hook="$hooks_dir/pre-push"
marker='VANA_MANAGED_EVM_KEYSCAN_PRE_PUSH=1'
if [[ -L "$hook" ]]; then
  printf 'Refusing to manage symlink hook: %s\n' "$hook" >&2
  exit 2
fi
desired_hook=$(mktemp)
trap 'rm -f "$desired_hook" "${tmp_hook:-}"' EXIT
cat >"$desired_hook" <<EOF
#!/usr/bin/env bash
# $marker
readonly VANA_SECRET_SCAN_HOME=$(printf '%q' "$shared_dir")
readonly VANA_SECRET_SCAN_EXPECTED_SHA=$(printf '%q' "$expected_sha")
exec env VANA_SECRET_SCAN_HOME="\$VANA_SECRET_SCAN_HOME" VANA_SECRET_SCAN_EXPECTED_SHA="\$VANA_SECRET_SCAN_EXPECTED_SHA" $(printf '%q' "$shared_dir/hooks/pre-push") "\$@"
EOF
is_exact_managed=0
if [[ -f "$hook" ]] && cmp -s "$desired_hook" "$hook"; then
  is_exact_managed=1
fi

verify_installed_gitleaks() {
  local binary="$shared_dir/.tools/gitleaks/gitleaks"
  local receipt="$shared_dir/.tools/gitleaks/gitleaks.sha256"
  [[ -x "$binary" && -f "$receipt" ]] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check --status "$receipt"
  else
    shasum -a 256 --check --status "$receipt"
  fi
}

case "$command_name" in
  status)
    if [[ $is_exact_managed -eq 1 ]]; then
      printf 'Vana EVM keyscan pre-push hook is installed at %s\n' "$hook"
    elif [[ -e "$hook" ]]; then
      printf 'A non-Vana pre-push hook exists at %s\n' "$hook"
      exit 1
    else
      printf 'Vana EVM keyscan pre-push hook is not installed for %s\n' "$repo"
      exit 1
    fi
    exit 0
    ;;
  uninstall)
    if [[ $is_exact_managed -eq 1 ]]; then
      rm "$hook"
      printf 'Removed Vana EVM keyscan pre-push hook at %s\n' "$hook"
      exit 0
    fi
    if [[ -e "$hook" ]]; then
      printf 'Refusing to remove hook not installed from this policy checkout: %s\n' "$hook" >&2
      exit 2
    fi
    printf 'No Vana EVM keyscan pre-push hook is installed for %s\n' "$repo"
    exit 0
    ;;
esac

if [[ -e "$hook" && $is_exact_managed -ne 1 ]]; then
  printf 'Refusing to overwrite existing hook: %s\nMerge it manually or use your hook manager.\n' "$hook" >&2
  exit 2
fi

if ! verify_installed_gitleaks; then
  "$shared_dir/scripts/install-gitleaks.sh" "$shared_dir/.tools/gitleaks" >/dev/null
fi
mkdir -p "$hooks_dir"
tmp_hook=$(mktemp "$hooks_dir/pre-push.vana.XXXXXX")
cp "$desired_hook" "$tmp_hook"
chmod 0755 "$tmp_hook"
mv "$tmp_hook" "$hook"
printf 'Installed Vana EVM keyscan pre-push hook at %s\n' "$hook"
