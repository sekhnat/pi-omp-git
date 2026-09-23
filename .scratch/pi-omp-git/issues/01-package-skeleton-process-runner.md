# 01: Package skeleton, process runner, and dependency gating

**What to build:** A loadable Pi package. `pi` discovers the extension through the package manifest (`pi` extensions entry, `pi-package` keyword, Node engine floor matching Pi's). Every `gh` and `git` subprocess in the package flows through one centralized runner that takes argument arrays (never shell interpolation), runs noninteractively with a stabilized locale, enforces the 5-minute timeout and 8 MiB output cap with honest truncation reporting, and terminates the child on cancellation. When `gh` is missing or unauthenticated, Git functionality keeps working and GitHub surfaces return the stable friendly errors. This ticket also lands the scripted-fixture test seam — recorded argv → stdout/exit fixtures — that every later ticket's tests inject at the runner.

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

- [x] The package loads via `pi -e` (or install) from the manifest declaration; `pi-package` keyword and engine floor present
- [x] A test injecting arguments containing shell metacharacters proves no shell interpolation occurs
- [x] Runner enforces timeout and output cap, reports truncation, and cancellation terminates the child process
- [x] Missing `gh` leaves Git functionality working and returns the dependency error for GitHub surfaces; unauthenticated `gh` returns the auth error
- [x] Noninteractive environment is set (prompts disabled, askpass disabled) without clobbering user-supplied auth variables; parsed outputs run under a stabilized locale
- [x] The scripted-fixture seam exists and drives the runner's own tests

## Comments

- Implemented 2026-07 (ticket 01). Central runner in `src/shared/subprocess.ts` (`createRunner` + default `spawnExec`), `gh`/`git` facades in `src/github/runner.ts` / `src/git/runner.ts`, scripted-fixture seam via `createScriptedExec` in `src/github/runner.ts`, dependency probes + friendly errors in `src/github/availability.ts` and `src/shared/errors.ts`, extension entry `src/index.ts` (registers `/omp-git-doctor`).
- Verification: `npm test` (vitest, 25 passing — real `node` child processes for timeout/cap/cancel with marker-file proof of child termination, plus the scripted seam), `npm run typecheck` clean, `biome check` clean, and `pi -e . --no-tools -p "…"` loads the package and completes a turn. Note: extension `/commands` are not dispatched in `--print` mode (TUI-only), so the doctor command is exercised interactively.
