# Design

## Context

The package has two runtime faces with different build needs: the Pi extension (`src/index.ts`, loaded by Pi's TypeScript loader, never needs compiled output) and the companion CLI (`bin/pi-omp-git.mjs` → `../dist/cli.js`, compiled by `prepack`). Distribution is git-only for now: `pi install <url>` clones the repository into `<agent dir>/git/<host>/<owner>/<repo>` (not under `node_modules`), and the CLI is additionally installable with `npm install -g git+<url>`.

Empirical facts driving the design (verified with disposable probes in `/tmp`, 2026-09-25):

1. npm git-dependency installs run **no `prepack`**; the current launcher therefore fails (`ERR_MODULE_NOT_FOUND` for `dist/cli.js`).
2. npm git-dependency installs **do run `prepare`**, and install the dependency's **devDependencies before `prepare`** runs.
3. Pi's git install runs `npm install --omit=dev` in the clone, and that **also runs `prepare`** — with development dependencies omitted.
4. Node refuses to import TypeScript from `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) but strips types fine everywhere else; Node 22.19+ is already the supported floor.

5. The clone's `node_modules` stays **empty**: the four host packages sit in both `peerDependencies` and `devDependencies` (the task 2.4 pinning), the dev edge shadows the peer edge, and `--omit=dev` prunes it (bisected with synthetic manifests). `src/cli.ts` imports the hosts at top level (27 root-specifier imports), so a plain source fallback cannot resolve in the Pi clone.
6. A module resolve hook mapping the four host specifiers into the user's Pi installation (npm global root plus the Pi package's nested `node_modules`) makes `src/cli.ts` load and run from the bare clone — verified end-to-end (`--help`, exit 0). Node 22.15+ provides `module.registerHooks`; the 22.19 floor has it. Pi's global install keeps only `pi-coding-agent` at the top level; its dependencies (including `typebox`) are nested under its own `node_modules`.
## Decisions

### Three-tier launcher (dist first, source fallback, Pi-hosted resolution)

`bin/pi-omp-git.mjs` resolves the CLI through up to three tiers: compiled `../dist/cli.js`, then `../src/cli.ts` via Node type stripping, then `../src/cli.ts` again with a resolve hook that maps host package imports into the user's Pi installation.

- Dist-first is mandatory, not stylistic: a tarball-installed package lives under `node_modules`, where the source fallback cannot work. Preferring `src` would break the published-artifact path.
- Dist-first is mandatory, not stylistic: a tarball-installed package lives under `node_modules`, where the source fallback cannot work. Preferring `src` would break the published-artifact path. The source fallback makes checkouts build-free (`npm ci` alone does not build); Pi's clone additionally needs the third tier below.
- The source fallback covers checkouts (their `node_modules` satisfies host imports). Pi's git clone is the hard case: its `node_modules` is empty (fact 5), so the first source attempt fails on host resolution. The third tier handles it: on a host-package module-not-found, locate the user's Pi installation — `npm root -g`, plus the Pi package's nested `node_modules` — register a `module.registerHooks` resolve hook for the four host specifiers, and retry the source import. The CLI thereby runs against the user's own Pi runtime: version-locked by construction, zero extra install weight, no network.
- Discovery failure is not silent: when neither the tree nor a discoverable Pi installation provides the hosts, the original module-not-found error surfaces with a stderr hint naming the missing package.
- The hook realpaths the entry it returns, so a host package's own dependencies resolve from the package's real location — symlinks (pnpm-style layouts, test fixtures) do not break transitive resolution.
- **Known stale-dist hazard**: after pulling source changes, a previously built `dist` shadows newer sources in checkouts. Accepted; README documents `npm run build` after pulls.
- Each engaged tier prints a one-line notice to stderr (source mode; host resolution from the Pi installation). stdout and exit codes are unchanged, so existing CLI and smoke assertions stay valid.
Alternative rejected: committing `dist/` to git (build artifacts in review diffs, staleness discipline); GitHub-release tarballs (extra friction, and contradicts git-only simplicity).

### Defensive prepare

`prepare` becomes `node scripts/prepare.mjs`: if `node_modules/.bin/tsc` is resolvable, run `npm run build` and propagate any failure; otherwise exit 0.

- Protects Pi's install path: probe 3 shows `prepare` runs with dev dependencies omitted, where a plain `npm run build` would fail the whole `pi install`.
- Keeps the npm-git path working: probe 2 shows devDependencies arrive before `prepare`, so the build tool is present exactly when a build is meaningful.
- The guard checks the tool, not an env var, so it cannot desync from reality. Real build failures still fail the install (spec requires it).

Alternative rejected: `prepare: npm run build || true` — swallows genuine build failures on the npm-git path, violating the failure-propagation requirement.

### PATH story (documented, not automated)

`pi install` will never modify the shell `PATH`. The README documents two equal options, using the installed clone's absolute path:

1. `npm install -g git+https://github.com/sekhnat/pi-omp-git.git` — a conventional global bin (built by `prepare`), at the cost of a second copy that can drift from the extension until reinstalled.
2. An alias or one-time symlink to `<agent dir>/git/github.com/sekhnat/pi-omp-git/bin/pi-omp-git.mjs` — version-locked to the extension by construction, which is the strongest way to honor the one-parser/two-hosts contract (ADR 0004).

No install script is shipped: two documented commands are simpler than a script that must be maintained and trusted.

### Version skew note

With option 1 the CLI updates only on reinstall; with option 2 it moves with `pi update`. The strict shared parser (ADR 0004) tolerates neither configuration *breaking*, but users should prefer option 2 while the extension tracks `main`.

## Risks

- Node's type-stripping behavior is the fallback's foundation; it is guaranteed on the supported floor (22.19+) outside `node_modules`. If Pi ever changes its git install root to sit under a `node_modules` tree, the fallback breaks — the smoke test should keep asserting the Pi-path CLI works.
- `prepare` runs on maintainer `npm install` too; it must stay fast (a plain `tsc` build, no pack).
- Host discovery assumes the user's Pi installation is reachable from the active node's global root (`npm root -g`). A Pi installed under a different node version's global root would be missed; the failure mode is a clear module-not-found error, not a hang. Revisit only if that bites in practice.
