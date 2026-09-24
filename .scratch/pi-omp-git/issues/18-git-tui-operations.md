# 18: File and hunk operations in the Git TUI

**What to build:** The `/git` UI becomes operational: unstaged files can be staged or discarded; staged files can be unstaged or discarded; untracked files can be staged or deleted. Textual diffs support hunk-level stage, unstage, and discard via validated Git patch primitives: every generated hunk patch is validated and target state verified before application, a partially applied patch is never reported as success, and any rejection is surfaced. Discard semantics are differentiated from unstage: "discard all changes in file" restores the index to HEAD and the working tree appropriately, removes untracked files when specifically requested, and warns — before the destructive action — that unstaged modifications to the same path will also be lost. Destructive discards require explicit UI intent, and conflicted files are never blindly discarded or staged by ordinary operations.

**Blocked by:** 17 (`/git` TUI core with headless state model).

**Status:** ready-for-human

- [x] File-level stage/unstage/discard work for unstaged, staged, and untracked files
- [x] Hunk-level stage/unstage/discard use validated patch primitives; partial application is never reported as success; rejections are surfaced
- [x] Discard-all warns that unstaged modifications on the same path will be lost before performing the destructive operation
- [x] Destructive actions require explicit confirmation intent
- [x] Conflicted files are protected from ordinary stage/discard operations
- [x] Repository state is verified with Git itself after every operation, not from UI state alone

## Comments

**Implemented** in `src/git/model-ops.ts`: file-level stage
(`git add -A -- <path> [origPath]`), unstage (`git restore --staged`),
unstaged-discard (`git restore --` keeps staged changes; untracked files
are deleted), and §66 discard-all (`git restore --source=HEAD --staged
--worktree`; staged additions are unstaged then removed). Hunk-level
stage/unstage/discard generate single-hunk patches (`extractHunkPatch`,
trailing-newline and no-newline-marker safe), validate with
`git apply --check` before applying, and verify the post-state by
re-reading the diff — the hunk's changed-line body must occur exactly one
fewer time, so a partially applied patch is never reported as success and
rejections are surfaced as `GitMutationError`. `discardAllWarning` states
that unstaged modifications to the same path will be lost; the TUI shows
it and requires `y` before destructive actions, swallowing other keys.
Conflicted files are refused by both the controller and the model
operations. Repository state is refreshed from Git after every mutation.
Tests: `test/git-model-ops.test.ts`, `test/git-tui.test.ts` — every
operation verified with Git commands afterwards.
