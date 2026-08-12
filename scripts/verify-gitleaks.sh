#!/usr/bin/env bash
# Verify the exact Gitleaks binary used by this policy.
set -euo pipefail

usage() {
  printf 'Usage: %s <tool-directory>\n' "${0##*/}" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
tool_dir=$1
[[ ! -L "$tool_dir" ]] || { printf 'Refusing symlink tool directory: %s\n' "$tool_dir" >&2; exit 2; }
binary="$tool_dir/gitleaks"
[[ ! -L "$binary" ]] || { printf 'Refusing symlink Gitleaks binary: %s\n' "$binary" >&2; exit 2; }
[[ -x "$binary" ]] || { printf 'Gitleaks executable not found: %s\n' "$binary" >&2; exit 2; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) expected='88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509' ;;
  Linux-aarch64|Linux-arm64) expected='00e91bbe655bd7c47753e8cfe61cb76ea1a5d7e7702fe161ee40102b46b3823b' ;;
  Darwin-arm64) expected='ba52fb1bfabbcde42f032afad3d6e0b19dff8ed105229a16e7caa338bbc0e84f' ;;
  Darwin-x86_64) expected='cee01fea7173f1b779dff188e1c26ecbcb4027d394acc573b23aaf0be260e291' ;;
  *) printf 'Unsupported platform: %s-%s\n' "$(uname -s)" "$(uname -m)" >&2; exit 2 ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$binary" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$binary" | awk '{print $1}')
fi
[[ "$actual" == "$expected" ]] || {
  printf 'Gitleaks binary checksum verification failed.\n' >&2
  exit 2
}
