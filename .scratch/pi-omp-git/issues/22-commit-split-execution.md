# 22: Split execution with conservation

**What to build:** `/commit` handles unrelated changes as multiple coherent commits. The plan is file-level: every selected path belongs to at most one commit, every intended change belongs to a commit, ordering respects dependencies, and a file containing unrelated concerns is placed in the dominant commit (hunk-level assignment is a recorded non-goal). The plan is displayed before execution in interactive mode; the split policy (confirm/auto/never) is explicit and configurable, and noninteractive behavior never depends on TTY detection. Execution is transactional: snapshot the original index/tree/untracked state, build each group's index, commit in order, and restore the intended residual unstaged/staged state. A failure at commit N stops immediately, reports which commits succeeded and which proposal failed, and leaves all uncommitted changes recoverable. Conservation is enforced by pre/post snapshot comparison — any mismatch, including hook side-effects or external concurrent modification, aborts with an execution error rather than proceeding silently.

**Blocked by:** 21 (`/commit` single proposal with dry-run).

**Status:** ready-for-agent

- [ ] Unrelated changes produce a multi-commit plan where every changed file lands in exactly one commit and nothing is left uncommitted
- [ ] The plan displays before execution in interactive mode; splitPolicy (confirm/auto/never) is honored; noninteractive behavior is explicit configuration, not TTY detection
- [ ] Transactional execution snapshots state, commits groups in order, and restores the intended residual state
- [ ] Failure at commit N: stops immediately, reports succeeded vs failed, uncommitted changes remain recoverable, error status returned
- [ ] A pre/post snapshot mismatch (hook side-effect or external change) aborts with an execution error — never a silent proceed
- [ ] Structural test assertions: one coherent commit or N coherent commits covering every changed file; the model's specific grouping is never asserted