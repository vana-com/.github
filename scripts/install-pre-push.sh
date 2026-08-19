#!/usr/bin/env bash
# Install the optional hook without overwriting another tool's pre-push hook.
set -euo pipefail

usage() {
  cat >&2 <<USAGE
Usage: ${0##*/} [install|prepare|status|uninstall] [options]

Options:
  --repo <repository>       Git repository to manage (default: current directory)
  --shared-dir <checkout>   Trusted vana-com/.github checkout (default: this checkout)
  --ref <sha>              Required 40-character policy commit

The install command writes only a small managed launcher. The prepare command
validates the policy checkout and installs the pinned Gitleaks binary without
touching repository hooks.
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
    --ref) expected_sha=${2:-}; shift 2 ;;
    --help|-h) usage ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage ;;
  esac
done
case "$command_name" in
  install|prepare|status|uninstall) ;;
  *) printf 'Unknown command: %s\n' "$command_name" >&2; usage ;;
esac
[[ -n "$expected_sha" ]] || { printf 'Missing required --ref <released-commit-sha>.\n' >&2; exit 2; }
[[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'Policy ref must be a 40-character lowercase commit ID.\n' >&2
  exit 2
}

# Git exports GIT_DIR (and friends) into hook processes. In a linked worktree
# that value is an ABSOLUTE path, so a plain `git -C "$shared_dir" ...` still
# resolves against the pushing repository and reports ITS HEAD, origin and
# status instead of the pinned policy checkout's — the hook then refuses a
# perfectly good checkout ("Vana scanner checkout is at <repo HEAD>"). In a
# normal checkout GIT_DIR is the relative ".git", which happens to resolve
# correctly under -C, which is why this only bites worktrees. Scrub the
# inherited repository environment for commands that must target the checkout;
# commands that scan the pushing repository keep it.
# The scrub list comes from git itself (`--local-env-vars` covers GIT_DIR,
# GIT_WORK_TREE, GIT_INDEX_FILE, the object-directory pair, and crucially
# GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT, which `git -c foo=bar push` exports
# into hooks and which would otherwise let the caller's environment satisfy the
# origin check below instead of the checkout's real config). The GIT_CONFIG_*
# file overrides are not in that list, so they are added explicitly, and a
# hardcoded fallback covers a git too old to answer.
_shared_git_scrub=()
while IFS= read -r _v; do
  [[ -n "$_v" ]] && _shared_git_scrub+=(-u "$_v")
done < <(git rev-parse --local-env-vars 2>/dev/null || printf '%s\n' \
  GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR \
  GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT)
for _v in GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM; do
  _shared_git_scrub+=(-u "$_v")
done
unset _v

shared_git() {
  # `-c` overrides neutralize execution-capable settings a poisoned checkout
  # could plant in its own .git/config: core.fsmonitor runs a command during
  # `git status`, and the *Proxy/*Command hooks run during fetch.
  env "${_shared_git_scrub[@]}" git \
    -c core.fsmonitor= \
    -c core.hooksPath=/dev/null \
    -c credential.helper= \
    -c protocol.ext.allow=never \
    -c uploadpack.packObjectsHook= \
    "$@"
}

shared_git -C "$shared_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  printf 'Policy checkout is not a Git work tree: %s\n' "$shared_dir" >&2
  exit 2
}
[[ -x "$shared_dir/hooks/pre-push" ]] || { printf 'No hook at: %s/hooks/pre-push\n' "$shared_dir" >&2; exit 2; }
[[ -x "$shared_dir/scripts/install-gitleaks.sh" ]] || { printf 'No installer at: %s/scripts/install-gitleaks.sh\n' "$shared_dir" >&2; exit 2; }
[[ -x "$shared_dir/scripts/verify-gitleaks.sh" ]] || { printf 'No verifier at: %s/scripts/verify-gitleaks.sh\n' "$shared_dir" >&2; exit 2; }
shared_dir=$(cd "$shared_dir" && pwd -P)
actual_sha=$(shared_git -C "$shared_dir" rev-parse HEAD)
[[ "$actual_sha" == "$expected_sha" ]] || {
  printf 'Policy checkout is at %s, expected %s.\n' "$actual_sha" "$expected_sha" >&2
  exit 2
}
origin_url=$(shared_git -C "$shared_dir" config --get remote.origin.url || true)
case "$origin_url" in
  git@github.com:vana-com/.github|git@github.com:vana-com/.github.git|https://github.com/vana-com/.github|https://github.com/vana-com/.github.git) ;;
  *) printf 'Policy checkout origin is not vana-com/.github: %s\n' "${origin_url:-<unset>}" >&2; exit 2 ;;
esac
if [[ -n "$(shared_git -C "$shared_dir" status --porcelain --untracked-files=all -- ':!/.tools')" ]]; then
  printf 'Policy checkout has local changes: %s\n' "$shared_dir" >&2
  exit 2
fi

tool_dir="$shared_dir/.tools/gitleaks"
prepare_gitleaks() {
  if ! "$shared_dir/scripts/verify-gitleaks.sh" "$tool_dir" >/dev/null 2>&1; then
    "$shared_dir/scripts/install-gitleaks.sh" "$tool_dir" >/dev/null
    "$shared_dir/scripts/verify-gitleaks.sh" "$tool_dir" >/dev/null
  fi
}

if [[ "$command_name" == prepare ]]; then
  prepare_gitleaks
  printf 'Prepared Vana EVM keyscan policy checkout at %s\n' "$shared_dir"
  exit 0
fi

git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || { printf 'Not a Git work tree: %s\n' "$repo" >&2; exit 2; }
repo=$(cd "$repo" && pwd -P)
configured_hooks_path=$(git -C "$repo" config --get core.hooksPath || true)
if [[ -n "$configured_hooks_path" ]]; then
  printf 'Refusing to manage repositories with core.hooksPath set: %s\n' "$configured_hooks_path" >&2
  exit 2
fi
hooks_dir=$(git -C "$repo" rev-parse --git-path hooks)
[[ "$hooks_dir" != /* ]] || { printf 'Refusing absolute hooks directory: %s\n' "$hooks_dir" >&2; exit 2; }
[[ "$hooks_dir" == .git/hooks ]] || { printf 'Refusing unexpected hooks directory: %s\n' "$hooks_dir" >&2; exit 2; }
git_dir=$(git -C "$repo" rev-parse --git-dir)
[[ "$git_dir" != /* ]] || { printf 'Refusing absolute Git directory: %s\n' "$git_dir" >&2; exit 2; }
git_dir_real=$(cd "$repo/$(dirname "$git_dir")" && pwd -P)/$(basename "$git_dir")
repo_real=$(cd "$repo" && pwd -P)
case "$git_dir_real" in
  "$repo_real/.git") ;;
  *) printf 'Refusing Git directory outside repository: %s\n' "$git_dir_real" >&2; exit 2 ;;
esac
if [[ -e "$repo/.git" && -L "$repo/.git" ]]; then
  printf 'Refusing symlink Git directory: %s\n' "$repo/.git" >&2
  exit 2
fi
hooks_dir="$repo/.git/hooks"
if [[ -e "$hooks_dir" && ! -d "$hooks_dir" ]]; then
  printf 'Refusing non-directory hooks path: %s\n' "$hooks_dir" >&2
  exit 2
fi
if [[ -L "$hooks_dir" ]]; then
  printf 'Refusing symlink hooks directory: %s\n' "$hooks_dir" >&2
  exit 2
fi
hook="$hooks_dir/pre-push"
if [[ -L "$hook" ]]; then
  printf 'Refusing symlink hook: %s\n' "$hook" >&2
  exit 2
fi

marker='VANA_MANAGED_EVM_KEYSCAN_PRE_PUSH=1'
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

case "$command_name" in
  status)
    "$shared_dir/scripts/verify-gitleaks.sh" "$tool_dir" >/dev/null
    if [[ $is_exact_managed -eq 1 && -x "$hook" ]]; then
      printf 'Vana EVM keyscan pre-push hook is installed at %s\n' "$hook"
      exit 0
    fi
    if [[ -e "$hook" ]]; then
      printf 'A non-Vana pre-push hook exists at %s\n' "$hook" >&2
    else
      printf 'Vana EVM keyscan pre-push hook is not installed for %s\n' "$repo" >&2
    fi
    exit 1
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

prepare_gitleaks
mkdir -p "$hooks_dir"
tmp_hook=$(mktemp "$hooks_dir/pre-push.vana.XXXXXX")
cp "$desired_hook" "$tmp_hook"
chmod 0755 "$tmp_hook"
mv "$tmp_hook" "$hook"
printf 'Installed Vana EVM keyscan pre-push hook at %s\n' "$hook"
