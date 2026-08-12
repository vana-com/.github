#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scanner="$root/scripts/scan-commit-range.sh"
config="$root/.gitleaks.toml"
gitleaks=${GITLEAKS_BIN:-gitleaks}
policy_sha=$(git -C "$root" rev-parse HEAD)

command -v "$gitleaks" >/dev/null 2>&1 || {
  printf 'Set GITLEAKS_BIN to a Gitleaks executable.\n' >&2
  exit 2
}

test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
repo="$test_root/repo"
git init -q -b main "$repo"
git -C "$repo" config user.name test
git -C "$repo" config user.email test@example.invalid

hook_repo="$test_root/hook-repo"
git init -q -b main "$hook_repo"
if "$root/scripts/install-pre-push.sh" --repo "$hook_repo"; then
  printf 'expected installer to require --ref\n' >&2
  exit 1
fi
"$root/scripts/install-pre-push.sh" --repo "$hook_repo" --ref "$policy_sha"
"$root/scripts/install-pre-push.sh" status --repo "$hook_repo" --ref "$policy_sha"
hook_path=$(git -C "$hook_repo" rev-parse --git-path hooks/pre-push)
[[ "$hook_path" = /* ]] || hook_path="$hook_repo/$hook_path"
grep -qF 'VANA_MANAGED_EVM_KEYSCAN_PRE_PUSH=1' "$hook_path"
"$root/scripts/install-pre-push.sh" --repo "$hook_repo" --ref "$policy_sha"
"$root/scripts/install-pre-push.sh" uninstall --repo "$hook_repo" --ref "$policy_sha"
if "$root/scripts/install-pre-push.sh" status --repo "$hook_repo" --ref "$policy_sha"; then
  printf 'expected status to fail after uninstall\n' >&2
  exit 1
fi
printf '#!/usr/bin/env bash\nexit 0\n' >"$hook_path"
chmod 0755 "$hook_path"
if "$root/scripts/install-pre-push.sh" --repo "$hook_repo" --ref "$policy_sha"; then
  printf 'expected installer to refuse unmanaged hook\n' >&2
  exit 1
fi
printf '#!/usr/bin/env bash\n# VANA_MANAGED_EVM_KEYSCAN_PRE_PUSH=1\nexit 0\n' >"$hook_path"
chmod 0755 "$hook_path"
if "$root/scripts/install-pre-push.sh" --repo "$hook_repo" --ref "$policy_sha"; then
  printf 'expected installer to refuse marker-spoofed hook\n' >&2
  exit 1
fi
rm "$hook_path"
ln -s /dev/null "$hook_path"
if "$root/scripts/install-pre-push.sh" --repo "$hook_repo" --ref "$policy_sha"; then
  printf 'expected installer to refuse symlink hook\n' >&2
  exit 1
fi

custom_hook_repo="$test_root/custom-hook-repo"
git init -q -b main "$custom_hook_repo"
git -C "$custom_hook_repo" config core.hooksPath custom-hooks
if "$root/scripts/install-pre-push.sh" --repo "$custom_hook_repo" --ref "$policy_sha"; then
  printf 'expected installer to refuse configured core.hooksPath\n' >&2
  exit 1
fi
if [[ -e "$custom_hook_repo/custom-hooks/pre-push" ]]; then
  printf 'prepare-only repo should not receive a pre-push hook\n' >&2
  exit 1
fi
"$root/scripts/install-pre-push.sh" prepare --repo "$custom_hook_repo" --ref "$policy_sha"
if [[ -e "$custom_hook_repo/custom-hooks/pre-push" ]]; then
  printf 'prepare should not touch repository hooks\n' >&2
  exit 1
fi
not_a_repo="$test_root/not-a-repo"
mkdir "$not_a_repo"
"$root/scripts/install-pre-push.sh" prepare --repo "$not_a_repo" --ref "$policy_sha"

if "$root/scripts/install-pre-push.sh" --repo "$custom_hook_repo" --ref 0000000000000000000000000000000000000000; then
  printf 'expected installer to refuse wrong policy SHA\n' >&2
  exit 1
fi
bad_origin="$test_root/bad-origin"
git clone -q "$root" "$bad_origin"
git -C "$bad_origin" remote set-url origin https://example.invalid/not-vana.git
git -C "$bad_origin" checkout -q "$policy_sha"
bad_origin_sha=$(git -C "$bad_origin" rev-parse HEAD)
if "$root/scripts/install-pre-push.sh" --repo "$custom_hook_repo" --shared-dir "$bad_origin" --ref "$bad_origin_sha"; then
  printf 'expected installer to refuse wrong policy origin\n' >&2
  exit 1
fi
dirty_policy="$test_root/dirty-policy"
git clone -q "$root" "$dirty_policy"
git -C "$dirty_policy" remote set-url origin https://github.com/vana-com/.github.git
git -C "$dirty_policy" checkout -q "$policy_sha"
dirty_sha=$(git -C "$dirty_policy" rev-parse HEAD)
printf '\n# dirty\n' >>"$dirty_policy/hooks/pre-push"
if "$root/scripts/install-pre-push.sh" --repo "$custom_hook_repo" --shared-dir "$dirty_policy" --ref "$dirty_sha"; then
  printf 'expected installer to refuse dirty policy checkout\n' >&2
  exit 1
fi
git -C "$dirty_policy" checkout -- hooks/pre-push
printf 'untracked\n' >"$dirty_policy/untracked.txt"
if "$root/scripts/install-pre-push.sh" prepare --shared-dir "$dirty_policy" --ref "$dirty_sha"; then
  printf 'expected installer to refuse untracked policy checkout files\n' >&2
  exit 1
fi
symlink_tool_dir="$test_root/symlink-tool-dir"
ln -s "$test_root/outside-tools" "$symlink_tool_dir"
if "$root/scripts/install-gitleaks.sh" "$symlink_tool_dir"; then
  printf 'expected Gitleaks installer to refuse symlink destination\n' >&2
  exit 1
fi
mkdir -p "$test_root/tool-with-symlink"
ln -s "$test_root/external-gitleaks" "$test_root/tool-with-symlink/gitleaks"
if "$root/scripts/install-gitleaks.sh" "$test_root/tool-with-symlink"; then
  printf 'expected Gitleaks installer to refuse symlink binary\n' >&2
  exit 1
fi
mkdir -p "$test_root/tool-with-receipt-symlink"
ln -s "$test_root/external-receipt" "$test_root/tool-with-receipt-symlink/gitleaks.sha256"
if "$root/scripts/install-gitleaks.sh" "$test_root/tool-with-receipt-symlink"; then
  printf 'expected Gitleaks installer to refuse symlink receipt\n' >&2
  exit 1
fi
tool_symlink_policy="$test_root/tool-symlink-policy"
git clone -q "$root" "$tool_symlink_policy"
git -C "$tool_symlink_policy" remote set-url origin https://github.com/vana-com/.github.git
git -C "$tool_symlink_policy" checkout -q "$policy_sha"
mkdir -p "$test_root/external-tools"
ln -s "$test_root/external-tools" "$tool_symlink_policy/.tools"
if "$tool_symlink_policy/scripts/install-pre-push.sh" prepare --shared-dir "$tool_symlink_policy" --ref "$policy_sha"; then
  printf 'expected prepare to refuse symlink .tools directory\n' >&2
  exit 1
fi

key='4f3c8b1a9e6d2c7f0b5e1d8a6c3f9b2e''7d4a1c8f5b0e6d3a9c2f7b4e1d8a6c3f'
scan() { "$scanner" --repo "$repo" --range "$1" --config "$config" --gitleaks "$gitleaks"; }
expect_scan_status() {
  local expected=$1 range=$2 actual
  set +e
  scan "$range"
  actual=$?
  set -e
  if [[ $actual -ne $expected ]]; then
    printf 'expected scan exit %s for %s, got %s\n' "$expected" "$range" "$actual" >&2
    return 1
  fi
}
commit_file() {
  local path=$1 content=$2 message=$3
  mkdir -p "$(dirname "$repo/$path")"
  printf '%s\n' "$content" >"$repo/$path"
  git -C "$repo" add -- ":(literal)$path"
  git -C "$repo" commit -q -m "$message"
  git -C "$repo" rev-parse HEAD
}
append_file() {
  local path=$1 content=$2 message=$3
  printf '%s\n' "$content" >>"$repo/$path"
  git -C "$repo" add "$path"
  git -C "$repo" commit -q -m "$message"
  git -C "$repo" rev-parse HEAD
}

base=$(commit_file clean.ts 'export const chainId = 43114;' base)
clean=$(commit_file hashes.ts 'export const digest = "7f83b1657ff1fc53b92dc18148a1d65dfa135014735e6b1b1b8d6a6b1e7d1f2a";' clean-hash)
scan "$base..$clean"
odd_path=$(commit_file 'odd names/--fixture [safe].ts' 'export const chainId = 43114;' odd-safe-path)
scan "$clean..$odd_path"
clean_twin=$(commit_file clean.txt 'export const release = true;' clean-pathspec-twin)
scan "$odd_path..$clean_twin"
pathspec_magic=$(commit_file ':(literal)clean.txt' "export const privateKey = \"$key\";" pathspec-magic-file)
if ! expect_scan_status 1 "$clean_twin..$pathspec_magic"; then
  printf 'expected a key in a pathspec-magic filename to be detected\n' >&2
  exit 1
fi
normal_hash=$(commit_file normal-hash.txt "$key" normal-hash-file)
scan "$pathspec_magic..$normal_hash"
git -C "$repo" update-index --add --cacheinfo "160000,$normal_hash,submodule"
git -C "$repo" commit -q -m gitlink
gitlink=$(git -C "$repo" rev-parse HEAD)
scan "$normal_hash..$gitlink"
type_base=$(commit_file private-key 'not-a-secret' type-change-base)
rm "$repo/private-key"
ln -s "$key" "$repo/private-key"
git -C "$repo" add --all private-key
git -C "$repo" commit -q -m type-change-key-file
type_change=$(git -C "$repo" rev-parse HEAD)
if ! expect_scan_status 1 "$type_base..$type_change"; then
  printf 'expected a key in a secret-named symlink file to be detected\n' >&2
  exit 1
fi
nested_key_file=$(commit_file config/private-key "$key" nested-secret-named-file)
if ! expect_scan_status 1 "$type_change..$nested_key_file"; then
  printf 'expected a key in a nested secret-named file to be detected\n' >&2
  exit 1
fi
spaced_key_file=$(commit_file 'config/private key' "$key" spaced-secret-named-file)
if ! expect_scan_status 1 "$nested_key_file..$spaced_key_file"; then
  printf 'expected a key in a spaced secret-named file to be detected\n' >&2
  exit 1
fi

direct_account=$(commit_file account.ts "privateKeyToAccount(\"$key\");" private-key-to-account)
if ! expect_scan_status 1 "$spaced_key_file..$direct_account"; then
  printf 'expected privateKeyToAccount to be detected\n' >&2
  exit 1
fi
direct_wallet=$(commit_file wallet.ts "new Wallet(\"$key\");" wallet-constructor)
if ! expect_scan_status 1 "$direct_account..$direct_wallet"; then
  printf 'expected Wallet constructor to be detected\n' >&2
  exit 1
fi
direct_signing_key=$(commit_file signing-key.ts "new SigningKey(\"$key\");" signing-key-constructor)
if ! expect_scan_status 1 "$direct_wallet..$direct_signing_key"; then
  printf 'expected SigningKey constructor to be detected\n' >&2
  exit 1
fi

leak=$(commit_file inline.ts "export const privateKey = \"$key\";" inline-key)
if ! expect_scan_status 1 "$direct_signing_key..$leak"; then
  printf 'expected inline private key to be detected\n' >&2
  exit 1
fi
message_collision=$(commit_file .git-commit-message "privateKey=$key" benign-commit-message)
if ! expect_scan_status 1 "$leak..$message_collision"; then
  printf 'expected a repository .git-commit-message file to be detected\n' >&2
  exit 1
fi
spaced_declaration=$(commit_file faucet-style.md "Private Key: $key" spaced-private-key-declaration)
if ! expect_scan_status 1 "$message_collision..$spaced_declaration"; then
  printf 'expected a spaced Private Key declaration to be detected\n' >&2
  exit 1
fi
previous_role=$spaced_declaration
role_labels=(Deployer Signer Wallet)
role_slugs=(deployer signer wallet)
for i in "${!role_labels[@]}"; do
  role=${role_labels[$i]}
  slug=${role_slugs[$i]}
  role_declaration=$(commit_file "role-$slug.md" "$role Key: $key" "$slug-key-declaration")
  if ! expect_scan_status 1 "$previous_role..$role_declaration"; then
    printf 'expected a %s Key declaration to be detected\n' "$role" >&2
    exit 1
  fi
  role_file=$(commit_file "config/$slug-key" "$key" "$slug-key-file")
  if ! expect_scan_status 1 "$role_declaration..$role_file"; then
    printf 'expected a %s-key file to be detected\n' "$slug" >&2
    exit 1
  fi
  previous_role=$role_file
done
hidden_key_file=$(commit_file .private-key "$key" hidden-private-key-file)
if ! expect_scan_status 1 "$previous_role..$hidden_key_file"; then
  printf 'expected a .private-key file to be detected\n' >&2
  exit 1
fi
plural_declaration=$(commit_file plural.ts "const privateKeys = [\"$key\"];" plural-private-keys-declaration)
if ! expect_scan_status 1 "$hidden_key_file..$plural_declaration"; then
  printf 'expected a plural privateKeys declaration to be detected\n' >&2
  exit 1
fi
prefixed_declaration=$(commit_file env.ts "export const ETH_PRIVATE_KEY_HEX = \"$key\";" prefixed-private-key-declaration)
if ! expect_scan_status 1 "$plural_declaration..$prefixed_declaration"; then
  printf 'expected a prefixed and suffixed private-key declaration to be detected\n' >&2
  exit 1
fi
abbreviated_declaration=$(commit_file p2p.yml "p2p-priv-key: $key" abbreviated-private-key-declaration)
if ! expect_scan_status 1 "$prefixed_declaration..$abbreviated_declaration"; then
  printf 'expected a priv-key declaration to be detected\n' >&2
  exit 1
fi
compound_declaration=$(commit_file compound.ts "const appPrivateKey = \"$key\";" compound-private-key-declaration)
if ! expect_scan_status 1 "$abbreviated_declaration..$compound_declaration"; then
  printf 'expected a compound private-key declaration to be detected\n' >&2
  exit 1
fi
signing_declaration=$(commit_file signing.ts "const signingKey = \"$key\";" signing-key-declaration)
if ! expect_scan_status 1 "$compound_declaration..$signing_declaration"; then
  printf 'expected a signing-key declaration to be detected\n' >&2
  exit 1
fi
suffixed_declaration=$(commit_file secret-buffer.ts "const secretKeyBuffer = \"$key\";" suffixed-secret-key-declaration)
if ! expect_scan_status 1 "$signing_declaration..$suffixed_declaration"; then
  printf 'expected a suffixed secret-key declaration to be detected\n' >&2
  exit 1
fi
compound_key_file=$(commit_file config/wallet-private-key "$key" compound-secret-named-file)
if ! expect_scan_status 1 "$suffixed_declaration..$compound_key_file"; then
  printf 'expected a compound secret-named file to be detected\n' >&2
  exit 1
fi
not_private_key=$(commit_file negative.ts $'notprivatekey = "'"$key"$'";\nprivatekeyhash = "'"$key"$'";\ngeneratePrivateKey("'"$key"$'");\nisValidPrivateKey("'"$key"$'");\npublicPrivateKey = "'"$key"$'";' non-secret-identifiers)
scan "$compound_key_file..$not_private_key"
low_entropy='0000000000000000000000000000000000000000000000000000000000000001'
low_entropy_commit=$(commit_file low-entropy.ts "export const privateKey = \"$low_entropy\";" low-entropy-key)
if ! expect_scan_status 1 "$not_private_key..$low_entropy_commit"; then
  printf 'expected the scalar-one private key to be detected\n' >&2
  exit 1
fi

removed=$(commit_file inline.ts 'export const removed = true;' remove-key)
if ! expect_scan_status 1 "$type_change..$removed"; then
  printf 'expected add-then-remove history to be detected\n' >&2
  exit 1
fi

split_base=$(commit_file split.ts 'export const privateKey =' split-declaration)
split=$(append_file split.ts "  \"$key\";" split-value)
if ! expect_scan_status 1 "$split_base..$split"; then
  printf 'expected split-line declaration to be detected\n' >&2
  exit 1
fi

allowed=$(commit_file allowed.ts "export const privateKey = \"$key\"; // gitleaks:allow" allowed-vector)
if ! expect_scan_status 1 "$split..$allowed"; then
  printf 'expected gitleaks:allow to remain blocked\n' >&2
  exit 1
fi

ecies_vectors=()
while IFS= read -r vector; do
  ecies_vectors+=("$vector")
done < <(awk '
  /description = "Published ECIES compatibility vectors"/ { wanted = 1; next }
  wanted && /stopwords = \[/ { values = 1; next }
  values && /^  ]/ { exit }
  values { print }
' "$config" | grep -Eo '[0-9a-f]{64}')
if [[ ${#ecies_vectors[@]} -ne 5 ]]; then
  printf 'expected five exact ECIES vector exceptions, got %s\n' "${#ecies_vectors[@]}" >&2
  exit 1
fi
previous=$allowed
fixture_path='packages/vana-sdk/src/crypto/ecies/test-vectors/eccrypto-vectors.json'
fixture_contents=''
for vector in "${ecies_vectors[@]}"; do
  fixture_contents+="export const privateKey = \"$vector\";"$'\n'
done
vector_commit=$(commit_file "$fixture_path" "$fixture_contents" published-vectors)
# One file exercises every approved ECIES compatibility value.
scan "$previous..$vector_commit"
previous=$vector_commit

cross_vector=$(awk '
  /description = "Published cross-platform encryption test constant"/ { wanted = 1; next }
  wanted && /stopwords = \[/ { values = 1; next }
  wanted && values && /^  ]/ { exit }
  values { print }
' "$config" | grep -Eo '[0-9a-f]{64}')
dummy_vector=$(awk '
  /description = "Published DPv2 dummy-account test constant"/ { wanted = 1; next }
  wanted && /stopwords = \[/ { values = 1; next }
  wanted && values && /^  ]/ { exit }
  values { print }
' "$config" | grep -Eo '[0-9a-f]{64}')
if [[ ! "$cross_vector" =~ ^[0-9a-f]{64}$ || ! "$dummy_vector" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'expected one cross-platform and one dummy-account exact exception\n' >&2
  exit 1
fi
cross_commit=$(commit_file 'packages/vana-sdk/src/tests/encryption-coverage.test.ts' "export const privateKey = \"$cross_vector\";" published-cross-platform-vector)
scan "$previous..$cross_commit"
previous=$cross_commit
dummy_commit=$(commit_file 'packages/vana-sdk/src/direct/controller.test.ts' $'const APP_KEY =\n  "'"$dummy_vector"$'";\nprivateKeyToAccount(APP_KEY);' published-dummy-account-vector)
scan "$previous..$dummy_commit"
previous=$dummy_commit

# A 32-byte identifier near (but not adjacent to) a generated direct-call key
# must not inherit direct-call context.
grant_id='abababababababababababababababababababababababababababababababab'
grant_commit=$(commit_file grant-id.ts $'const GRANT_ID = "'"$grant_id"$'";\n// unrelated\n// unrelated\nprivateKeyToAccount(generatePrivateKey());' grant-id-is-not-a-private-key)
scan "$previous..$grant_commit"
previous=$grant_commit
multiline_call=$(commit_file multiline-call.ts $'privateKeyToAccount(\n  "'"$key"$'"\n);' multiline-direct-api-call)
if ! expect_scan_status 1 "$previous..$multiline_call"; then
  printf 'expected a multiline direct wallet API literal to be detected\n' >&2
  exit 1
fi

# Exception paths are exact snapshot paths: an untrusted shadow prefix is not
# a fixture path and must never inherit the exception.
shadow=$(commit_file "evil/$fixture_path" "export const privateKey = \"${ecies_vectors[0]}\";" shadowed-fixture-path)
if ! expect_scan_status 1 "$multiline_call..$shadow"; then
  printf 'expected an allowlisted value in a shadow fixture path to be detected\n' >&2
  exit 1
fi
previous=$shadow

# The documentation mock has its own exact-value and path exception.
faucet_vector='59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
faucet=$(commit_file 'docs/plans/2026-06-26-faucet-agent-claim-api.md' "privateKey = \"$faucet_vector\"" published-faucet-mock)
scan "$previous..$faucet"

# Scalar zero is an invalid secp256k1 key used as Vana's explicit
# must-be-replaced validator default. Its exception remains value-and-path exact.
zero_sentinel='0000000000000000000000000000000000000000000000000000000000000000'
sentinel=$(commit_file '.env.example' "DEPOSIT_PRIVATE_KEY=$zero_sentinel" invalid-validator-key-sentinel)
scan "$faucet..$sentinel"
sentinel_in_production=$(commit_file sentinel-production.ts "const privateKey = \"$zero_sentinel\";" sentinel-outside-approved-path)
if ! expect_scan_status 1 "$sentinel..$sentinel_in_production"; then
  printf 'expected the invalid sentinel outside its approved paths to be detected\n' >&2
  exit 1
fi
sentinel_mutation=$(commit_file '.env.example' "DEPOSIT_PRIVATE_KEY=$low_entropy" valid-scalar-in-sentinel-path)
if ! expect_scan_status 1 "$sentinel_in_production..$sentinel_mutation"; then
  printf 'expected a valid scalar in a sentinel path to be detected\n' >&2
  exit 1
fi

# Changing a single nibble must not inherit an exception, even in a fixture.
synthetic_key="${ecies_vectors[0]%?}5"
synthetic=$(commit_file "$fixture_path" "export const privateKey = \"$synthetic_key\";" synthetic-near-vector)
if ! expect_scan_status 1 "$sentinel_mutation..$synthetic"; then
  printf 'expected an unknown key in an allowed fixture path to be detected\n' >&2
  exit 1
fi

# A known public vector is still suspicious when copied into production code.
production=$(commit_file production.ts "export const privateKey = \"${ecies_vectors[0]}\";" published-vector-in-production)
if ! expect_scan_status 1 "$synthetic..$production"; then
  printf 'expected an allowlisted vector in production code to be detected\n' >&2
  exit 1
fi

# Published upstream examples are exempt only as the exact reviewed
# value-and-path set. Verify the inventory shape before exercising its bounds.
upstream_inventory() {
  local target=$1
  awk -v target="$target" '
    /description = "Published upstream wallet-library examples vendored in Vana"/ {
      block += 1
      wanted = (block == target)
      next
    }
    wanted && /paths = \[/ { section = "paths"; next }
    wanted && /stopwords = \[/ { section = "stopwords"; next }
    wanted && /^  ]/ {
      if (section == "stopwords") exit
      section = ""
      next
    }
    wanted && section != "" && /^    / { print }
  ' "$config"
}
upstream_first="$test_root/upstream-first"
upstream_second="$test_root/upstream-second"
upstream_inventory 1 >"$upstream_first"
upstream_inventory 2 >"$upstream_second"
upstream_blocks=$(grep -c '^  description = "Published upstream wallet-library examples vendored in Vana"$' "$config")
if [[ $upstream_blocks -ne 2 ]] || ! cmp -s "$upstream_first" "$upstream_second"; then
  printf 'expected two identical rule-scoped upstream inventories\n' >&2
  exit 1
fi
upstream_paths=$(awk '
  /description = "Published upstream wallet-library examples vendored in Vana"/ { wanted = 1; next }
  wanted && /paths = \[/ { values = 1; next }
  wanted && values && /^  ]/ { exit }
  wanted && values { print }
' "$config" | grep -c "^    '''")
upstream_values=()
while IFS= read -r vector; do
  upstream_values+=("$vector")
done < <(awk '
  /description = "Published upstream wallet-library examples vendored in Vana"/ { wanted = 1; next }
  wanted && /stopwords = \[/ { values = 1; next }
  wanted && values && /^  ]/ { exit }
  wanted && values { print }
' "$config" | grep -Eo '[0-9a-f]{64}')
if [[ $upstream_paths -ne 14 || ${#upstream_values[@]} -ne 86 ]]; then
  printf 'expected 14 exact upstream paths and 86 exact upstream values, got %s and %s\n' "$upstream_paths" "${#upstream_values[@]}" >&2
  exit 1
fi
upstream_path='stats-client/node_modules/@noble/curves/README.md'
upstream_value=''
upstream_mutated=''
for candidate in "${upstream_values[@]}"; do
  if [[ ${candidate: -1} == 0 ]]; then
    mutation="${candidate%?}1"
  else
    mutation="${candidate%?}0"
  fi
  mutation_is_reviewed=false
  for reviewed in "${upstream_values[@]}"; do
    if [[ $mutation == "$reviewed" ]]; then
      mutation_is_reviewed=true
      break
    fi
  done
  if [[ $mutation_is_reviewed == false ]]; then
    upstream_value=$candidate
    upstream_mutated=$mutation
    break
  fi
done
if [[ -z $upstream_value || -z $upstream_mutated ]]; then
  printf 'expected a reviewed upstream value with an unreviewed one-nibble mutation\n' >&2
  exit 1
fi
upstream_allowed=$(commit_file "$upstream_path" "const privateKey = \"$upstream_value\";" published-upstream-example)
scan "$production..$upstream_allowed"
upstream_direct_allowed=$(commit_file "$upstream_path" "const account = privateKeyToAccount(\"$upstream_value\");" published-upstream-direct-example)
scan "$upstream_allowed..$upstream_direct_allowed"
upstream_shadow=$(commit_file "evil/$upstream_path" "const privateKey = \"$upstream_value\";" upstream-example-shadow-prefix)
if ! expect_scan_status 1 "$upstream_direct_allowed..$upstream_shadow"; then
  printf 'expected an upstream value in a shadow path to be detected\n' >&2
  exit 1
fi
upstream_suffix=$(commit_file "$upstream_path.bak" "const privateKey = \"$upstream_value\";" upstream-example-path-suffix)
if ! expect_scan_status 1 "$upstream_shadow..$upstream_suffix"; then
  printf 'expected an upstream value in a suffixed path to be detected\n' >&2
  exit 1
fi
upstream_nested=$(commit_file "nested/$upstream_path" "const privateKey = \"$upstream_value\";" upstream-example-nested-path)
if ! expect_scan_status 1 "$upstream_suffix..$upstream_nested"; then
  printf 'expected an upstream value in a nested path to be detected\n' >&2
  exit 1
fi
upstream_mutation=$(commit_file "$upstream_path" "const privateKey = \"$upstream_mutated\";" upstream-example-one-nibble-mutation)
if ! expect_scan_status 1 "$upstream_nested..$upstream_mutation"; then
  printf 'expected a one-nibble upstream-value mutation to be detected\n' >&2
  exit 1
fi

set +e
"$scanner" --repo "$repo" --range 'does-not-exist..HEAD' --config "$config" --gitleaks "$gitleaks" >/dev/null 2>&1
invalid_range_status=$?
"$scanner" --repo "$repo" --range "$allowed" --config "$config" --gitleaks /does-not-exist >/dev/null 2>&1
missing_tool_status=$?
set -e
if [[ $invalid_range_status -ne 2 || $missing_tool_status -ne 2 ]]; then
  printf 'expected invalid range and missing tool to exit 2, got %s and %s\n' "$invalid_range_status" "$missing_tool_status" >&2
  exit 1
fi
fake_git_dir="$test_root/fake-git"
mkdir -p "$fake_git_dir"
printf '#!/usr/bin/env bash\nif [[ "${1:-}" == "-C" && "${3:-}" == "cat-file" ]]; then exit 1; fi\nexec %q "$@"\n' "$(command -v git)" >"$fake_git_dir/git"
chmod 0755 "$fake_git_dir/git"
if PATH="$fake_git_dir:$PATH" "$scanner" --repo "$repo" --range "$base..$clean" --config "$config" --gitleaks "$gitleaks" >/dev/null 2>&1; then
  printf 'expected a missing selected blob to fail closed\n' >&2
  exit 1
fi
# Gitleaks skips its active config path. Commit a copy under another name so
# the test proves embedded reviewed values do not create a self-finding.
policy_copy=$(commit_file policy-copy.toml "$(<"$config")" policy-config-copy)
scan "$upstream_mutation..$policy_copy"

fake_gitleaks="$test_root/fake-gitleaks"
printf '#!/usr/bin/env bash\nprintf "%s\\n" %q >&2\nexit 42\n' "$key" >"$fake_gitleaks"
chmod 0755 "$fake_gitleaks"
tool_error="$test_root/tool-error"
tool_status=0
if "$scanner" --repo "$repo" --range "$clean..$leak" --config "$config" --gitleaks "$fake_gitleaks" >"$tool_error" 2>&1; then
  printf 'expected Gitleaks tool error to fail closed\n' >&2
  exit 1
else
  tool_status=$?
fi
if [[ $tool_status -ne 2 ]]; then
  printf 'expected scanner error exit code 2, got %s\n' "$tool_status" >&2
  exit 1
fi
if ! grep -Eq 'Scanner error.*Gitleaks exit 42' "$tool_error"; then
  printf 'expected a useful scanner-error message\n' >&2
  exit 1
fi
if grep -Fq "$key" "$tool_error"; then
  printf 'scanner error exposed a candidate value\n' >&2
  exit 1
fi

# The optional hook should inherit the trusted checkout selected by its
# installer and must not print the candidate value when it blocks a push.
"$root/scripts/install-pre-push.sh" --shared-dir "$root" --repo "$repo" --ref "$policy_sha" >/dev/null
hook_output="$test_root/hook-output"
if (cd "$repo" && printf 'refs/heads/main %s refs/heads/main %040d\n' "$allowed" 0 |
    .git/hooks/pre-push origin example.invalid) >"$hook_output" 2>&1; then
  printf 'expected optional pre-push hook to block a key-bearing history\n' >&2
  exit 1
fi
if grep -Fq "$key" "$hook_output"; then
  printf 'pre-push hook exposed a candidate value\n' >&2
  exit 1
fi

hook_policy="$test_root/hook-policy"
git clone -q "$root" "$hook_policy"
git -C "$hook_policy" remote set-url origin https://github.com/vana-com/.github.git
git -C "$hook_policy" checkout -q "$policy_sha"
"$hook_policy/scripts/install-pre-push.sh" --repo "$repo" --shared-dir "$hook_policy" --ref "$policy_sha" >/dev/null
mv "$hook_policy/.tools/gitleaks/gitleaks" "$hook_policy/.tools/gitleaks/gitleaks.missing"
if (cd "$repo" && printf 'refs/heads/main %s refs/heads/main %040d\n' "$clean" 0 |
    .git/hooks/pre-push origin example.invalid) >/dev/null 2>&1; then
  printf 'expected pre-push hook to fail closed when Gitleaks is missing\n' >&2
  exit 1
fi
mv "$hook_policy/.tools/gitleaks/gitleaks.missing" "$hook_policy/.tools/gitleaks/gitleaks"
printf '#!/usr/bin/env bash\nexit 0\n' >"$hook_policy/.tools/gitleaks/gitleaks"
chmod 0755 "$hook_policy/.tools/gitleaks/gitleaks"
if (cd "$repo" && printf 'refs/heads/main %s refs/heads/main %040d\n' "$clean" 0 |
    .git/hooks/pre-push origin example.invalid) >/dev/null 2>&1; then
  printf 'expected pre-push hook to fail closed when Gitleaks is tampered\n' >&2
  exit 1
fi
"$hook_policy/scripts/install-pre-push.sh" uninstall --repo "$repo" --shared-dir "$hook_policy" --ref "$policy_sha" >/dev/null
"$root/scripts/install-pre-push.sh" --shared-dir "$root" --repo "$repo" --ref "$policy_sha" >/dev/null

# A new branch based on already published history scans only its new commits.
new_branch=$(commit_file new-branch.ts 'export const release = true;' new-branch)
git -C "$repo" update-ref refs/remotes/origin/main "$upstream_mutation"
if ! (cd "$repo" && printf 'refs/heads/new %s refs/heads/new %040d\n' "$new_branch" 0 |
    .git/hooks/pre-push origin example.invalid) >/dev/null 2>&1; then
  printf 'expected new branch to exclude existing remote history\n' >&2
  exit 1
fi
"$root/scripts/install-pre-push.sh" --shared-dir "$root" --repo "$repo" --ref "$policy_sha" >/dev/null

git -C "$repo" commit --allow-empty -q -m "privateKey=$key"
message_commit=$(git -C "$repo" rev-parse HEAD)
if ! expect_scan_status 1 "$new_branch..$message_commit"; then
  printf 'expected a private key in a commit message to be detected\n' >&2
  exit 1
fi

# A merge can introduce a resolution that exists in neither parent. `-m` is
# required when enumerating changed paths for this commit.
merge_base=$message_commit
git -C "$repo" checkout -q -b merge-left "$merge_base"
left=$(commit_file conflict.ts 'export const conflict = "left";' merge-left)
git -C "$repo" checkout -q -b merge-right "$merge_base"
right=$(commit_file conflict.ts 'export const conflict = "right";' merge-right)
git -C "$repo" checkout -q merge-left
if git -C "$repo" merge --no-commit merge-right >/dev/null 2>&1; then
  printf 'expected a merge conflict\n' >&2
  exit 1
fi
printf 'export const privateKey = "%s";\n' "$key" >"$repo/conflict.ts"
git -C "$repo" add conflict.ts
git -C "$repo" commit -q -m merge-resolution
merge_commit=$(git -C "$repo" rev-parse HEAD)
if ! expect_scan_status 1 "$merge_base..$merge_commit"; then
  printf 'expected a private key introduced by a merge resolution to be detected\n' >&2
  exit 1
fi

printf 'All scanner tests passed.\n'
