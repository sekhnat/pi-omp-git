# 17: `/git` TUI core with headless state model

**What to build:** `/git` opens a full-screen interactive UI: a repository/branch/HEAD header, a file sidebar with staged, unstaged, and conflicted sections, a split old/new diff pane, and an action/status bar. The UI is driven by an explicit state model — root, branch, HEAD, staged/unstaged/conflicted files, selection, revision mode — that is refreshable from actual repository state and testable headless without a terminal. State is re-read from Git after every mutation, never inferred from process exit text, and a path with both staged and unstaged changes shows both states. All supported Git file states appear: modified, added, deleted, renamed, copied, untracked, conflicted, binary, and LFS pointer.

**Blocked by:** 01 (package skeleton, process runner, and dependency gating).

**Status:** ready-for-human

- [x] `/git` opens the interactive layout with header, file sidebar, diff pane, and action bar; it requires a TTY
- [x] The state model is testable headless: clean repository, staged-only, unstaged-only, mixed same-file, untracked, rename, delete, binary, conflict
- [x] State refreshes from actual Git output after every mutation, never from exit text
- [x] A path with both staged and unstaged changes displays both states
- [x] All listed Git file states render correctly (including binary and LFS pointer recognition)

## Comments

**Implemented** (tickets 17–18 phase): headless model in
`src/git/status-model.ts` — `git status --porcelain=v2 --branch
--untracked-files=all` parsed into staged/unstaged/conflicted `GitFile`
entries (X/Y codes mapped to modified/added/deleted/renamed/copied/
typechange/untracked/conflicted), binary recognition from
`git diff --numstat` ("- -"), Git LFS pointer recognition by content, and
branch/HEAD from the porcelain `#` metadata. A path with staged and
unstaged changes appears in both lists. `fetchFileDiff` serves staged
(`git diff --cached`), unstaged (`git diff`), and untracked
(`git diff --no-index /dev/null`) diffs, parsed into hunks
(`src/git/diff.ts`), with the §68 4 MiB per-file limit checked from blob
sizes before loading. `src/git/tui.ts` holds the headless controller plus
the pure `renderGitTui` (§61 layout: header, sidebar sections, split
old/new diff pane, action bar) and a `ctx.ui.custom()` component;
`/git` is registered in `src/index.ts` guarded to TUI mode. Tests:
`test/git-status-model.test.ts`, `test/git-tui.test.ts` — model and
renderer exercised without a terminal over real git in temp repos.
