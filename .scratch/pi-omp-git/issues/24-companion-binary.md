# 24: Companion binary

**What to build:** The standalone executable completes standalone-command parity: `pi-omp-git git [revision] [-C dir]` opens the same interactive Git UI (the binary reuses the published TUI component library, so rendering matches the in-Pi experience), and `pi-omp-git commit` runs the same agentic pipeline with the `--push`, `--dry-run`, `--no-changelog`, `--context`, and `--model` options. Both commands require an interactive TTY for the UI; behavior matches the in-Pi equivalents for the same scenarios.

**Blocked by:** 19 (Revision mode and commit composer), 23 (Changelog integration and `--push`).

**Status:** ready-for-agent

- [ ] `pi-omp-git git [revision] [-C dir]` opens the interactive UI reusing the shared TUI component library; it requires a TTY
- [ ] `pi-omp-git commit` exposes `--push`, `--dry-run`, `--no-changelog`, `--context`, and `--model`
- [ ] The same acceptance scenarios pass against the binary as against the in-Pi commands (checkout invariants, commit correctness contract)