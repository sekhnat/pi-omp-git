# Contributing to pi-omp-git

Thanks for helping improve `pi-omp-git`. This document covers the minimum you
need to build, test, and send changes.

## Development setup

- Node.js **22.19+** with `git` on `PATH`. A working `gh` is optional; tests
  script it at the runner seam and never touch the network or your real
  GitHub account.
- `npm ci` installs pinned dependencies. The Pi host packages
  (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-tui`, `typebox`) are peer dependencies pinned as dev
  dependencies, so the source checkout runs against exactly the versions Pi
  supplies at runtime.

## Canonical checks

```sh
npm run check        # typecheck + Biome + full Vitest suite
npm run smoke:pack   # pack the tarball and verify it in an isolated fixture
```

`npm run check` is the gate CI runs; keep it green. The individual pieces are
available as `npm run typecheck`, `npm run lint`, and `npm test`.

## Tests

- Git integration tests use real temporary repositories created per test;
  GitHub tests script `gh` through the runner seam. Do not add tests that
  require live GitHub access or credentials.
- Pure planners (`src/github/operations/planning.ts`, `src/git/commit-args.ts`)
  have I/O-free unit tests; keep new pure logic there when practical.
- Commit-safety behavior (staged-only default, `--all` staging, dry-run
  invariance, index restoration) is covered by `test/commit-pipeline.test.ts`;
  extend those scenarios when touching `src/git/commit-pipeline.ts`.

## Documentation map

- `README.md` — user-facing behavior. Update it whenever user-visible
  behavior changes; documented examples must match the implementation.
- `docs/pi-omp-git-reference.md` — section index mapping the `§N` citations
  used in source/test comments to real components.
- `docs/adr/` — architecture decision records. Add one for cross-cutting
  design decisions (see `0004-shared-commit-hosts.md` for the format).
- `CHANGELOG.md` — add entries under the unreleased version for
  user-visible changes, especially compatibility changes.

## Submitting changes

1. Branch from `main` and keep the change focused.
2. Ensure `npm run check` and `npm run smoke:pack` pass locally.
3. Add or update tests for behavior changes; bug fixes should include a
   regression test.
4. Update `README.md` and `CHANGELOG.md` for user-visible changes.
5. Open a pull request; CI runs the canonical check on Ubuntu and macOS.

## Releases

Releases are manual and gated; see `RELEASING.md`. Do not publish without
following that checklist.
