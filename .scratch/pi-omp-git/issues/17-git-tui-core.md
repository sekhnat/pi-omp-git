# 17: `/git` TUI core with headless state model

**What to build:** `/git` opens a full-screen interactive UI: a repository/branch/HEAD header, a file sidebar with staged, unstaged, and conflicted sections, a split old/new diff pane, and an action/status bar. The UI is driven by an explicit state model — root, branch, HEAD, staged/unstaged/conflicted files, selection, revision mode — that is refreshable from actual repository state and testable headless without a terminal. State is re-read from Git after every mutation, never inferred from process exit text, and a path with both staged and unstaged changes shows both states. All supported Git file states appear: modified, added, deleted, renamed, copied, untracked, conflicted, binary, and LFS pointer.

**Blocked by:** 01 (package skeleton, process runner, and dependency gating).

**Status:** ready-for-agent

- [ ] `/git` opens the interactive layout with header, file sidebar, diff pane, and action bar; it requires a TTY
- [ ] The state model is testable headless: clean repository, staged-only, unstaged-only, mixed same-file, untracked, rename, delete, binary, conflict
- [ ] State refreshes from actual Git output after every mutation, never from exit text
- [ ] A path with both staged and unstaged changes displays both states
- [ ] All listed Git file states render correctly (including binary and LFS pointer recognition)