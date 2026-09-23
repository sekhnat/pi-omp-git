# 12: Batch checkout, fork remotes, and partial success

**What to build:** `pr_checkout` accepts an array of PR identifiers: each PR is checked out independently, one failed PR never rolls back unrelated successes, and the partial-success contract holds — at least one success yields a successful result containing both `checkouts[]` and structured `failures[]` (each failure classified by the error taxonomy), while zero successes yields a tool error with the same structured body (divergence D4). Fork PRs resolve a push-capable head-repository remote: an existing remote already pointing at the correct head repository is reused, otherwise a transport-matched `fork-<owner>`-style remote is added (HTTPS origin prefers HTTPS, SSH origin prefers SSH). Identifiers are text — a number as a string, a PR URL, or a branch-like identifier; JSON numbers are rejected.

**Blocked by:** 11 (`pr_checkout` single PR with managed worktree and mutation lock).

**Status:** ready-for-agent

- [ ] Array checkout: every PR is attempted; successes are never rolled back due to other failures
- [ ] ≥1 success → successful result with `checkouts[]` + `failures[]`; 0 successes → tool error with the same structured body
- [ ] Fork PRs get a push-capable head remote; a correct existing remote is reused; new remotes match the origin's transport
- [ ] Identifiers: number-as-text, PR URL, and branch-like forms all work; JSON numbers are rejected
- [ ] Each failure entry carries an error-classification from the taxonomy
