# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

First public candidate release. Version not yet published; see
[RELEASING.md](RELEASING.md) for the release gates.

### Changed — intentional compatibility changes

1. **Trusted project configuration takes precedence over user configuration.**
   Configuration resolves as defaults ← user file ← trusted project file ←
   environment overrides, later layer winning per key; invalid values fall
   back to the layer below. Previously a valid user value always won.
   Untrusted project configuration is still never read.

2. **Pi-owned state resolves under Pi's configured agent directory.** The
   extension now uses Pi's resolved agent directory for its config file,
   cache, worktree, and artifact paths instead of assuming `~/.pi/agent`.
   Environments that set a custom agent directory (`PI_CODING_AGENT_DIR`)
   will see these paths move.

3. **`github.enabled: false` now actually disables GitHub integration.** The
   `github` tool is not advertised, tool calls and virtual `issue://`/`pr://`
   reads report `GitHub integration is disabled by configuration.`, prompt
   guidance and shell-mutation observers are suppressed, and cache
   construction stays deferred. Previously the setting was parsed but never
   consulted. Git-only features keep working.

4. **Commits operate on the staged set by default.** `/commit` and
   `pi-omp-git commit` no longer stage the whole dirty tree when nothing is
   staged; they return an actionable no-staged-changes result that stages,
   commits, and pushes nothing (even with `--push`). Explicit `--all` opts
   into staging tracked modifications, deletions, and untracked files, with
   the real index updated only after a valid proposal is approved. Dry runs
   never mutate the index.

5. **One strict commit-option parser for both hosts.** Unknown flags, missing
   or invalid values, duplicate `--context`/`--model`, and bare positional
   arguments are now errors instead of being silently ignored or split on
   whitespace. Quoted multi-word contexts are supported; after `--`, the
   remaining words are treated as context.

### Added

- `/omp-git-doctor` and `pi-omp-git doctor`: shared, redacted environment
  diagnostics for tool versions, availability, authentication, configuration
  sources, and path writability.
- `npm run check`: canonical gate (typecheck, Biome, full Vitest suite).
- `npm run smoke:pack`: packed-tarball verification in an isolated fixture
  (entrypoints, Pi extension loading, declared peers).
- Push/pull-request CI on Node 22 (Ubuntu and macOS matrix).
- MIT `LICENSE`, `SECURITY.md`, this changelog, contributor instructions
  (`CONTRIBUTING.md`), and the manual release checklist (`RELEASING.md`).
- All directly imported Pi host packages declared as peer dependencies with
  pinned development versions; package metadata (repository, bugs, homepage).
- `docs/pi-omp-git-reference.md` section index and
  `docs/adr/0004-shared-commit-hosts.md`.
