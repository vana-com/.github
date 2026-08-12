#!/usr/bin/env bash
# Download the exact Gitleaks release used by this repository and verify it.
set -euo pipefail

readonly VERSION='8.30.1'
readonly RELEASE_BASE="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}"

usage() {
  printf 'Usage: %s [destination-directory]\n' "${0##*/}" >&2
  exit 2
}

[[ $# -le 1 ]] || usage
script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
destination=${1:-"$script_root/.tools/gitleaks"}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    asset="gitleaks_${VERSION}_linux_x64.tar.gz"
    sha256='551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
    ;;
  Linux-aarch64|Linux-arm64)
    asset="gitleaks_${VERSION}_linux_arm64.tar.gz"
    sha256='e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080'
    ;;
  Darwin-arm64)
    asset="gitleaks_${VERSION}_darwin_arm64.tar.gz"
    sha256='b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5'
    ;;
  Darwin-x86_64)
    asset="gitleaks_${VERSION}_darwin_x64.tar.gz"
    sha256='dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709'
    ;;
  *)
    printf 'Unsupported platform: %s-%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 2
    ;;
esac

parent=$(dirname "$destination")
[[ ! -L "$parent" ]] || { printf 'Refusing symlink tool parent directory: %s\n' "$parent" >&2; exit 2; }
mkdir -p "$parent"
parent_real=$(cd "$parent" && pwd -P)
destination="$parent_real/$(basename "$destination")"
[[ ! -L "$destination" ]] || { printf 'Refusing symlink destination: %s\n' "$destination" >&2; exit 2; }
if [[ "$destination" == "$script_root/.tools/gitleaks" ]]; then
  case "$destination/" in
    "$script_root/"*) ;;
    *) printf 'Refusing default tool directory outside policy checkout: %s\n' "$destination" >&2; exit 2 ;;
  esac
fi
if [[ -e "$destination" && ! -d "$destination" ]]; then
  printf 'Refusing non-directory destination: %s\n' "$destination" >&2
  exit 2
fi
[[ ! -L "$destination/gitleaks" ]] || { printf 'Refusing symlink Gitleaks binary: %s\n' "$destination/gitleaks" >&2; exit 2; }
[[ ! -L "$destination/gitleaks.sha256" ]] || { printf 'Refusing symlink Gitleaks receipt: %s\n' "$destination/gitleaks.sha256" >&2; exit 2; }
mkdir -p "$destination"
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

archive="$workdir/$asset"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "$RELEASE_BASE/$asset" --output "$archive"
if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --status
else
  printf '%s  %s\n' "$sha256" "$archive" | shasum -a 256 --check --status
fi
tar -xzf "$archive" -C "$workdir" gitleaks
install -m 0755 "$workdir/gitleaks" "$destination/gitleaks"
"$destination/gitleaks" version >&2
