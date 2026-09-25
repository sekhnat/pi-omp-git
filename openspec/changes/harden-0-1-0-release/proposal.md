# Proposal

## Why

The Git/GitHub implementation is substantial, but installation, configuration, command safety, and release verification are not yet dependable enough for 0.1.0. This change stabilizes those boundaries before publication, without adding new GitHub features or replacing the existing Git/commit execution model.

## What Changes

- **BREAKING**: Trusted project configuration takes precedence over user configuration; untrusted project configuration remains excluded. Resolve Pi-owned state under Pi's configured agent directory.
- **BREAKING**: Make `github.enabled=false` actually disable GitHub integration, including virtual reads, model-facing operations, guidance, and background/cache work, while retaining Git-only features.
- **BREAKING**: `/commit` and the companion CLI commit staged changes by default, not the entire dirty tree; explicit `--all` opts into staging tracked changes, deletions, and untracked files. Dry runs never mutate the index. Preserve proposal validation and transaction verification.
- **BREAKING**: Use one strict commit-option parser for both hosts; invalid flags and missing values are errors, not silently ignored.
- Declare all directly imported Pi host packages as peers, pin appropriate local development dependencies, and correct package metadata and published contents. Add `npm run check`, CI, and a clean-fixture packed-package smoke check.
- Expand `/omp-git-doctor` (and the CLI when feasible) into safe, actionable diagnostics. Decompose the GitHub dispatcher incrementally into operation-owned validation/handlers with a small shared runtime context, preserving existing operation names, inputs, outcomes, caching, and mutation semantics.
- Add MIT license, security policy, changelog, contributor/release instructions, repair dangling reference/ADR citations, and gate any release on version/tag agreement, checks, and tarball validation. Use a documented manual release checklist unless automated publication is deliberately configured.

## Capabilities

### New Capabilities

- `configuration-resolution`: Trust-aware layer precedence and Pi-resolved agent-directory state for both hosts.
- `github-integration-gate`: Effective GitHub enable/disable behavior across extension surfaces and background work.
- `commit-safety`: Staged-only default, explicit stage-all, dry-run immutability, and preserved commit verification.
- `commit-command-interface`: Shared strict commit argument semantics across Pi and the companion CLI.
- `package-verification`: Installable package contract, canonical checks, CI, and packed-tarball verification/release gates.
- `environment-diagnostics`: Redacted, status-classified environment diagnostics.

### Modified Capabilities

None; `openspec list --specs` reports no existing project capability specs.

## Impact

`src/shared/config.ts`, `src/index.ts`, `src/cli.ts`, `src/git/commit-pipeline.ts`, the GitHub dispatcher/operations/cache/read router, their tests, `package.json`/lockfile, CI workflows, README, and new release/security/license documents. Existing temporary-repository and scripted GitHub tests provide regression baselines. Source inspection confirms reversed user/project precedence, hard-coded agent-directory fallbacks, an ineffective `github.enabled`, implicit `git add -A .`, divergent argument parsing, missing Pi peer declarations, and no current CI/release documents; these observations must be rechecked against the implementation state at apply time.
