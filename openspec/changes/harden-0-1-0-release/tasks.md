# Tasks

## 1. Safety and configuration

- [x] 1.1 Install locked development dependencies and run the existing typecheck, Biome, and Vitest baselines; record any pre-existing failures before changing behavior and verify the observed code paths in `src/shared/config.ts`, `src/index.ts`, `src/cli.ts`, and `src/git/commit-pipeline.ts`. Baseline: `npm ci`, typecheck, and 21 Vitest tests pass; direct Biome reports existing `package.json` formatting error.
- [x] 1.2 Add trust/precedence tests for user-only, trusted-project-over-user, untrusted project, invalid higher-layer fallback, and supported environment overrides; verify the new tests fail for reversed precedence and pass after the fix.
- [x] 1.3 Correct `loadConfig`'s highest-valid-layer selection and expose discovered/active layer metadata for doctor without duplicating parsing; verify the configuration tests pass and invalid JSON remains nonfatal.
- [x] 1.4 Replace hard-coded agent-directory construction in extension, CLI TUI, dispatcher, Actions artifacts, default cache/worktrees, and other Pi-owned paths with Pi's resolved directory; verify custom `PI_CODING_AGENT_DIR` tests in both hosts and explicit override tests.
- [x] 1.5 Add feature-gate regression tests for disabled `github` tool/mutations, virtual resource reads, guidance, shell observers, cache probes, re-enabled state, and Git-only commands; verify no `gh` or SQLite cache operation occurs when disabled.
- [x] 1.6 Enforce `github.enabled` at advertisement/activation and execution boundaries, including the GitHub-dependent commit-push path; verify disabled responses are specific and all feature-gate tests pass.
- [x] 1.7 Replace compatibility-staging expectations in `test/commit-pipeline.test.ts` with staged-only, dirty-unstaged, only-untracked, clean-tree, and mixed staged/unstaged assertions; verify HEAD/index invariance and no unintended push.
- [x] 1.8 Implement the no-staged-changes result and explicit pipeline `all` option while preserving clean-tree push, split confirmation, changelog, and transaction checks; verify staged-only and clean-tree integration tests pass.
- [x] 1.9 Add a disposable-index all-changes planning path (including staged/unstaged, deletion, untracked, partially staged files and complete preview diffs); verify dry-run `--all` leaves HEAD, index, and working tree unchanged in real-repo tests.
- [x] 1.10 Delay real-index stage-all until after proposal validation/approval, guard against intervening state changes, and verify the planned tree matches the staged tree; verify successful `--all` commits and failed/absent proposal index-invariance tests plus existing conservation tests pass.

## 2. Commit command and package contract

- [x] 2.1 Add a table-driven shared-argument test matrix covering all known options, `--all`, quoted/multiword context, `--`, duplicates, missing/empty values, flag-shaped values, and unknown/positional errors; verify it runs against both host adapters.
- [x] 2.2 Introduce the shared token parser and Pi raw-input tokenizer, migrate `/commit` to it, and ensure parsing errors reach Pi UI before execution; verify argument tests and extension command tests pass.
- [x] 2.3 Migrate `pi-omp-git commit` to the same parser while retaining CLI-only `-C` and the existing `/git` revision syntax; verify `test/companion-binary.test.ts` and CLI invalid-argument/`--all` integration tests pass.
- [x] 2.4 Audit direct runtime imports and correct `package.json` peer/development dependencies and lockfile for the four observed host packages (and any additional direct imports); verify `npm ci`, `npm run typecheck`, and a manifest-to-import audit pass without production duplicates.
- [x] 2.5 Add accurate `repository`, `bugs`, `homepage`, `files`, and license metadata using the actual project remote; verify `npm pack --dry-run --json` lists both entrypoints and required files.

## 3. Automated checks and packed-package validation

- [x] 3.1 Add `npm run check` for typecheck, Biome, and Vitest and make temporary-Git test configuration portable; verify the canonical command succeeds locally with `npm ci`.
- [x] 3.2 Add push/PR GitHub Actions CI on Node 22 using `npm ci`, `npm run check`, and a maintainable Linux/macOS matrix for Git-sensitive verification; verify workflow syntax and successful checks on both platforms.
- [x] 3.3 Implement `npm run smoke:pack` to pack, inspect, install in an isolated fixture with declared Pi peers, load the Pi extension via a supported Pi loader, invoke CLI `--help`, and clean up; verify it fails if a peer or published entrypoint is removed and passes for the actual tarball.
- [x] 3.4 Run the canonical check and tarball smoke in CI after the manifest work; verify the CI workflow uses the same local commands and does not require GitHub network access for ordinary tests.

## 4. Diagnostics and dispatcher boundaries

- [x] 4.1 Implement an injectable, bounded, redacted doctor collector and formatter for versions, Git/gh/auth state, active/discovered config, agent/worktree/cache paths and writability, cwd/repo; verify tests for disabled gh, missing gh, custom directory, unwritable cache, and token non-disclosure.
- [x] 4.2 Wire `/omp-git-doctor` and `pi-omp-git doctor` to the shared diagnostic model with host-specific presentation; verify equivalent classified data in scripted extension and CLI tests without a Pi session for the CLI.
- [x] 4.3 Extract a typed GitHub operation registry/context with operation-owned parameter schemas/validators and results while retaining exported operation names and the current tool-facing schema; migrate `repo_view`, `file_read`, and searches first and verify existing dispatcher tests after each group.
- [x] 4.4 Migrate `pr_create`, `pr_checkout`, and `pr_push` handlers to operation-owned validation/execution/result mapping without changing mutation-lock or cache invalidation behavior; verify representative validation, checkout batch, push, and existing dispatcher tests.
- [x] 4.5 Migrate `run_watch` including streamed progress and artifacts to the registry; verify existing watch/cancellation and dispatcher tests, including result details and output bounds.
- [x] 4.6 Extract focused pure input/ref/target planning from PR checkout and Actions watching where side-effect separation is useful; verify new planner unit tests and unchanged scripted GitHub operation behavior without live network access.

## 5. Release and repository hygiene

- [x] 5.1 Update README configuration, GitHub disable, `--all` safety migration, consistent commit flags, diagnostics, package install, and `npm run check` guidance; verify all documented examples match the implemented CLI and extension behavior.
- [x] 5.2 Add actual MIT `LICENSE`, `SECURITY.md`, `CHANGELOG.md` with the five intentional compatibility changes, and concise contributor/development instructions; verify files are present in the inspected tarball where appropriate.
- [x] 5.3 Resolve references to missing `docs/pi-omp-git-reference.md`, ADR 0004, and other dangling source/doc citations by adding narrowly scoped reference material or correcting citations; verify a repository-wide reference search finds no dangling references.
- [x] 5.4 Document a manual npm release checklist that fails on tag/version mismatch, `npm run check`, `npm run smoke:pack`, or tarball inspection; verify a simulated mismatched tag is rejected before any publish action and no credentials are committed.
- [x] 5.5 Set candidate version to 0.1.0 in manifest/lockfile only after the gates are operational, run `npm ci && npm run check && npm run smoke:pack` on a clean supported environment, and verify tag/version and packed-package install/load before declaring release readiness; do not publish as part of this task without separate authorization.
