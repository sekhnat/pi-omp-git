# Tasks

## 1. Launcher and prepare mechanics

- [x] 1.1 Make `bin/pi-omp-git.mjs` three-tier: (1) attempt `../dist/cli.js`; (2) fall back to `../src/cli.ts` with a stderr notice, surfacing the loader error without fallback when a `dist` entry exists but fails to load; (3) on a host-package module-not-found, locate the user's Pi installation (`npm root -g` plus the Pi package's nested `node_modules`), register a `module.registerHooks` resolve hook mapping the four host specifiers, and retry the source import; when no Pi installation is discoverable, surface the original error with a stderr hint. stdout and exit codes unchanged.
- [x] 1.2 Add `scripts/prepare.mjs` and wire `prepare` in `package.json`: build via `npm run build` when `node_modules/.bin/tsc` is resolvable, exit 0 when it is not, and propagate build failures.

## 2. Tests

- [x] 2.1 Launcher tests: runs from source when `dist` is absent, prefers `dist` when present (assert the fallback is not used), surfaces a broken-`dist` load error, passes `--help` and a real subcommand through both modes, resolves host imports from fixture Pi roots (stubbed `npm` on `PATH`), and fails with the hint when nothing provides the hosts.
- [x] 2.2 Prepare tests: skips the build without dev dependencies, builds when they are present, and fails the install on a real build error.
- [x] 2.3 Two portable, offline install simulations: (a) a full git clone of the repo installed with `--omit=dev` (empty `node_modules`) whose launcher resolves hosts from fixture Pi roots — symlinks to the repo's `node_modules` — and runs `--help` successfully; (b) a synthetic git+file:// fixture whose `prepare` fires during npm's git-dependency install, produces built output, and the installed bin runs in dist mode.

## 3. Documentation

- [x] 3.1 README: add the install matrix (extension/CLI per install method), the two `PATH` options (global git install, or alias/symlink to the Pi clone), the stale-`dist` rebuild note for checkouts, and correct the Companion CLI section's build prerequisite.
- [x] 3.2 CHANGELOG: add the git-install CLI delivery and launcher behavior under the unreleased 0.1.0 entry.

## 4. Verification

- [x] 4.1 Run `npm run check` and `npm run smoke:pack`; verify smoke still passes with the launcher preferring `dist` under `node_modules`, and run a `pi -e <installed-git-clone>` probe to confirm the extension loads from the git-installed tree with the fallback launcher in place.
