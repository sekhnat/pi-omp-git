# 11: `pr_checkout` single PR with managed worktree and mutation lock

**What to build:** `github {op: "pr_checkout", pr: "418"}` checks one PR out into a dedicated managed worktree under the configurable root, leaving the user's primary checkout on its original branch and commit — always. The local PR branch is `pr-418`, persisted with OMP-compatible branch metadata (head ref, PR URL, cross-repository and maintainer-can-modify flags) so later pushes are deterministic. An existing `pr-418` branch matching the PR head is reused; a mismatch fails with a clear conflict unless `force` explicitly resets — never a silent reset. This ticket also lands the repository mutation lock: all shared-repository mutations serialize by primary repository root (in-process mutex plus an advisory lockfile in the repository's Git directory), with the guarantee scoped to mutations issued through the extension. Worktree collisions get bounded numeric suffixes; existing worktree detection keys on the branch reference, not the path. The result prominently carries the worktree path.

**Blocked by:** 08 (`github` dispatcher with `repo_view` and `file_read`).

**Status:** ready-for-agent

- [ ] A single PR checks out into a managed worktree; the user's original branch and commit are verifiably unchanged
- [ ] Local branch is `pr-<number>` with the exact OMP-compatible branch metadata keys persisted
- [ ] Correct-SHA existing branch is reused; wrong-SHA fails with a clear conflict; `force` resets; no silent reset ever occurs (divergence D2)
- [ ] Existing worktrees are detected primarily by branch reference; path collisions take bounded suffixes
- [ ] The mutation lock serializes concurrent mutations by primary repository root, including across two worktrees of the same repository; simultaneous checkout calls do not race
- [ ] The result carries the worktree path and checkout details (branch, PR, reused flag)
