# vana-com shared GitHub configuration

This repository contains Vana's trusted EVM private-key policy. Gitleaks is the
authoritative primary scanner. A separate advisory job enriches only Gitleaks
findings with EVM address derivation and public-chain liveness checks.

## What the CI check does

The reusable workflow scans **every commit introduced by a pull request**. For
each commit it scans complete snapshots of only that commit's changed files.
This matters for two cases that an endpoint diff misses:

- a key added in one commit and removed in a later commit; and
- a value added below an unchanged `privateKey` declaration.

The rule finds 64-hex-character EVM private-key candidates when they are within
two lines of a secret-shaped declaration or stored in a secret-named file such
as `private-key`. It intentionally does not scan arbitrary 32-byte hashes.
Findings are redacted; the workflow prints a commit ID, never the candidate
value. The advisory job deduplicates the primary candidates across the whole
range before it queries RPC endpoints. It reports active-address findings and
incomplete endpoint checks as warnings; an internal scanner or inventory error
still fails that job.

The advisory scanner runs only code from the immutable policy checkout. It
materializes caller Git objects as data and does not run caller scripts, install
caller dependencies, or use a caller package lifecycle. Its implementation is
Apache-2.0 because it adapts Vana smart-contracts PR 69 by Maciej; see
[`scripts/evm-key-liveness/NOTICE`](scripts/evm-key-liveness/NOTICE).

This release does **not** detect BIP-39 mnemonics. A reliable mnemonic rule
must validate the BIP-39 checksum against its word list to avoid flagging normal
prose. Gitleaks alone cannot do that deterministically, so this project makes no
mnemonic-detection claim.

## Use from a protected pull-request workflow

Create this small caller workflow in each participating repository:

```yaml
name: secret scan
on:
  pull_request:

permissions:
  contents: read

jobs:
  evm-key-scan:
    uses: vana-com/.github/.github/workflows/evm-key-scan.yml@<released-commit-sha>
```

Replace `<released-commit-sha>` with the 40-character commit ID of a reviewed
release. This pin is immutable, so all repositories run the reviewed central
implementation. Keep the small caller workflow code-owned, so a pull request
cannot change the central pin without the security owner's review. The Gitleaks
scan is the authoritative job; whether it is required for merge remains a
separate, approved branch-protection decision in each caller repository.

The workflow pins Gitleaks `v8.30.1` and verifies the downloaded archive's
SHA-256 before executing it. Action references use immutable commit IDs. It
checks out the pull request and the trusted policy as sibling directories, so
untrusted pull-request content cannot shadow the policy checkout.

## Optional local pre-push safeguard

Git hooks are not policy: they can be missing, stale, or bypassed with
`git push --no-verify`. CI and branch protection are the enforcement layer.
The hook is still useful because it stops an accidental public leak before it
leaves the workstation.

Clone this repository at the same reviewed release commit somewhere durable.
From that checkout, run:

```bash
scripts/install-pre-push.sh --repo /path/to/public-repo --ref <released-commit-sha>
```

The installer requires the selected checkout to come from `vana-com/.github`,
match the exact release SHA, and have no local changes. It installs the pinned
Gitleaks binary when the local copy is missing or fails checksum verification,
then records the selected policy checkout in a managed launcher. No shell
environment setup is required. Use `status` to inspect the launcher and
`uninstall` to remove it. To move a repository to a newer reviewed release,
uninstall with the old release SHA, then install with the new release SHA.

The installer refuses to overwrite or remove an unmanaged hook. Use a hook
manager or merge the launcher deliberately when another pre-push hook already
exists.

The hook verifies the policy checkout SHA, verifies that the checkout has no
local changes, and verifies the Gitleaks binary checksum before each push. It
does not download tools during `git push`; if the tool is missing or has the
wrong checksum, it fails closed and asks the developer to re-run the installer.
It sends no source or candidate values over the network. For a new remote
branch, it scans only commits not reachable from locally fetched
`refs/remotes/<remote>` tips; run `git fetch <remote>` first if those refs may
be stale.

## False positives and remediation

Inline `gitleaks:allow` comments are disabled. For published compatibility
vectors, add a centrally reviewed exception that requires both the exact value
and an anchored fixture or documentation path. Never allowlist a commit, a path
alone, or a value alone.

Do not treat a value as harmless because it appears in a test or load-test
file. A reviewed historical inventory found operational Moksha accounts in
SDK load-test data; those values are intentionally not excepted. Exceptions in
this policy are limited to independently verified inert compatibility or dummy
constants, an invalid configuration sentinel, and a documentation mock.

One additional reviewed exception covers 86 published upstream wallet-library
example values that Vana vendors under 14 exact `stats-client/node_modules`
paths. It requires both a listed value and one of those anchored paths. It does
not exempt `node_modules` generally, a path suffix or shadow path, or a
value outside the reviewed set.

If the check finds a real key, remove it from all unpushed commits and rotate it.
Deleting it in a later commit does not make it safe: the earlier commit can
still be uploaded, cloned, cached, or indexed.

## Verify a checkout

```bash
scripts/install-gitleaks.sh .tools/gitleaks
GITLEAKS_BIN=$PWD/.tools/gitleaks/gitleaks tests/run.sh
npm ci --ignore-scripts --prefix scripts/evm-key-liveness
GITLEAKS_BIN=$PWD/.tools/gitleaks/gitleaks node --test scripts/evm-key-liveness/scan.test.mjs
```

The test harness covers inline keys, clean hashes, add-then-remove history,
split-line declarations, path-and-value exceptions, commit messages, merge
resolutions, secret-named files, upstream-vendored-example exception bounds,
and fail-closed argument and tool failures. It creates its own throwaway Git
repository. The liveness tests use mocked RPC
responses for scalar validation, address derivation, active and inactive
accounts, incomplete checks, redaction, and range materialization.

## Codex PR review

`.github/workflows/codex-review-reusable.yml` is a shared, `workflow_call`
reusable workflow that runs an automated Codex review on every pull request
and posts the result as a PR comment. Consuming repositories no longer
maintain their own copy of this logic, so improvements (the fork-PR safety
gate, prompt tuning, cost tracking) land once here instead of drifting across
repos. Cost tracking and a couple of other proposed additions are being held
for a follow-up PR pending review — see that PR's description for what's
outstanding.

### Adopt it in a repository

Add this thin caller workflow at `.github/workflows/codex-review.yml` in the
consuming repository:

```yaml
name: Codex review
on:
  pull_request:
    types: [opened, reopened, synchronize]

permissions:
  contents: read

jobs:
  review:
    uses: vana-com/.github/.github/workflows/codex-review-reusable.yml@main
    secrets: inherit
```

`secrets: inherit` forwards the calling repository's `OPENAI_API_KEY` (an
organization or repository secret) to the reusable workflow. This is the
standard pattern for an org-wide reusable workflow consumed by many
repositories: it avoids naming every secret at every call site, and this
workflow only reads a single well-known secret name (`OPENAI_API_KEY`), so
there is no risk of over-sharing unrelated secrets into it. Repositories that
prefer to be explicit can instead pass `secrets: { OPENAI_API_KEY: ...}`.

This workflow is pinned to `@main` rather than a release SHA, unlike the
EVM key-scan workflow above. That is a deliberate difference: the key-scan
policy is a security control where an unreviewed change landing silently in
every caller is the exact failure this repo exists to prevent, so it pins to
an immutable, reviewed commit. This review workflow's blast radius is a worse
or missing PR comment — annoying, not dangerous — so it optimizes for callers
always getting the latest prompt fixes without a manual pin bump. If a future
consumer needs reproducible-forever CI behavior, pin to a
commit SHA instead of `@main` in that repo's caller workflow.

### Inputs

| Input    | Default       | Purpose                                    |
|----------|---------------|---------------------------------------------|
| `model`  | `gpt-5.6-sol` | Codex model used for the review.           |
| `effort` | `high`        | Reasoning effort passed to the model.      |

Override either from the caller when needed:

```yaml
jobs:
  review:
    uses: vana-com/.github/.github/workflows/codex-review-reusable.yml@main
    with:
      model: gpt-5.6-terra
      effort: medium
    secrets: inherit
```

These were previously read from `vars.CODEX_REVIEW_MODEL` /
`vars.CODEX_REVIEW_EFFORT` org variables in each repo's own copy of this
workflow. A `workflow_call` reusable workflow's own `vars.*` references do
resolve against the calling repository's configuration variables, but relying
on that implicitly is a poor fit for a workflow meant to be called from many
repositories: the effective model/effort for a given caller would depend on
org- or repo-level variables that are invisible at the call site itself.
Explicit `inputs` make the override visible in the caller's own workflow file
and keep the contract self-documenting; repos that already set
`CODEX_REVIEW_MODEL`/`CODEX_REVIEW_EFFORT` variables can pass them through
explicitly with `with: { model: ${{ vars.CODEX_REVIEW_MODEL }}, ... }`.

The reviewer never runs on pull requests from forks, because fork PRs do not
receive repository secrets — this is enforced inside the reusable workflow
itself (`if: github.event.pull_request.head.repo.full_name == github.repository`
on the `review` job), not something each caller needs to re-implement.

## License

The repository root is [MIT licensed](LICENSE). The isolated
[`scripts/evm-key-liveness`](scripts/evm-key-liveness) adaptation is
[Apache-2.0 licensed](scripts/evm-key-liveness/LICENSE); its
[NOTICE](scripts/evm-key-liveness/NOTICE) preserves the source attribution.
