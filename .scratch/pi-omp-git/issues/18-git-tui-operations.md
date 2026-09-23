# 18: File and hunk operations in the Git TUI

**What to build:** The `/git` UI becomes operational: unstaged files can be staged or discarded; staged files can be unstaged or discarded; untracked files can be staged or deleted. Textual diffs support hunk-level stage, unstage, and discard via validated Git patch primitives: every generated hunk patch is validated and target state verified before application, a partially applied patch is never reported as success, and any rejection is surfaced. Discard semantics are differentiated from unstage: "discard all changes in file" restores the index to HEAD and the working tree appropriately, removes untracked files when specifically requested, and warns — before the destructive action — that unstaged modifications to the same path will also be lost. Destructive discards require explicit UI intent, and conflicted files are never blindly discarded or staged by ordinary operations.

**Blocked by:** 17 (`/git` TUI core with headless state model).

**Status:** ready-for-agent

- [ ] File-level stage/unstage/discard work for unstaged, staged, and untracked files
- [ ] Hunk-level stage/unstage/discard use validated patch primitives; partial application is never reported as success; rejections are surfaced
- [ ] Discard-all warns that unstaged modifications on the same path will be lost before performing the destructive operation
- [ ] Destructive actions require explicit confirmation intent
- [ ] Conflicted files are protected from ordinary stage/discard operations
- [ ] Repository state is verified with Git itself after every operation, not from UI state alone