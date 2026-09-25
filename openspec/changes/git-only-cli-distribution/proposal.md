# Proposal

## Why

Distribution is git-only for now, but installing the extension must also deliver a working companion CLI. Today it does not: `pi install <url>` clones the repository but the CLI launcher targets `dist/cli.js`, which no git-driven flow ever builds — `npm install -g git+https://...` runs no `prepack`, and a naive `prepare: npm run build` fix would break `pi install` itself because Pi installs the clone's dependencies with `--omit=dev` (no TypeScript) yet still runs `prepare` (verified empirically against both npm and Pi's package manager).

## What Changes

- **Dual-mode CLI launcher**: `bin/pi-omp-git.mjs` tries the compiled `dist/cli.js` first (required under `node_modules`, where Node refuses to strip TypeScript) and falls back to importing `src/cli.ts` (Node type stripping) when `dist` is absent. Pi's git clone and source checkouts are outside `node_modules`, so the fallback works there.
- **Defensive prepare step**: `prepare` builds `dist` only when dev dependencies are installed; otherwise it exits successfully. npm git-dependency installs receive devDependencies before `prepare`, so they produce a working global CLI; Pi's `--omit=dev` install skips the build and stays healthy.
- **README install matrix and PATH story**: document which install methods provide the extension and/or the CLI, the alias-or-symlink option for putting the Pi-installed CLI on `PATH`, and the rebuild-after-pull note for checkouts with a stale `dist`.
- **Launcher and prepare tests**: fallback-to-source when `dist` is missing, dist-priority when present, failure surfacing when both fail, and the prepare guard's skip/build/propagate behavior.
- No new Git or GitHub features; npm publication remains out of scope and `RELEASING.md` gates are unchanged.

## Capabilities

### New Capabilities

- `cli-distribution`: The git-source install contract — installing the package from a git source provides both the Pi extension and a runnable companion CLI, with defined launcher behavior, build-script safety, and documented `PATH` setup.

### Modified Capabilities

None; the existing `package-verification` capability (npm tarball contract, canonical gates, CI, release checklist) is untouched by this change.
