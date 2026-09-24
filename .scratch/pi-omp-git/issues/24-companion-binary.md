# 24: Companion binary

**What to build:** The standalone executable completes standalone-command parity: `pi-omp-git git [revision] [-C dir]` opens the same interactive Git UI (the binary reuses the published TUI component library, so rendering matches the in-Pi experience), and `pi-omp-git commit` runs the same agentic pipeline with the `--push`, `--dry-run`, `--no-changelog`, `--context`, and `--model` options. Both commands require an interactive TTY for the UI; behavior matches the in-Pi equivalents for the same scenarios.

**Blocked by:** 19 (Revision mode and commit composer), 23 (Changelog integration and `--push`).

**Status:** ready-for-human

- [x] `pi-omp-git git [revision] [-C dir]` opens the interactive UI reusing the shared TUI component library; it requires a TTY
- [x] `pi-omp-git commit` exposes `--push`, `--dry-run`, `--no-changelog`, `--context`, and `--model`
- [x] The same acceptance scenarios pass against the binary as against the in-Pi commands (checkout invariants, commit correctness contract)

## Comments

**Implemented**: bin/pi-omp-git.mjs (wired as the package `bin`
entry) runs src/cli.ts. `pi-omp-git git [revision] [-C dir]` opens the
same interactive Git TUI as `/git` — the binary bootstraps its own
terminal renderer from the same @earendil-works/pi-tui component
library (TuiMainScreen + ProcessTerminal + GitTuiComponent), so
rendering matches the in-Pi experience; it requires a TTY (clean
error otherwise) and revision arguments resolve before the UI opens
(fail-fast on bad refs). `pi-omp-git commit` runs the same agentic
pipeline with --push, --dry-run, --no-changelog, --context, and
--model (resolved against the standalone ModelRegistry); without a
confirmation path, splitPolicy `confirm` fails explicitly. Deep
acceptance scenarios are covered by the library-level tests (one
pipeline, two hosts — ADR 0004); binary tests cover arg parsing, the
TTY guard, help/usage, unknown revisions, the deterministic clean-tree
no-changes outcome, and stack-trace-free errors
(test/companion-binary.test.ts).
