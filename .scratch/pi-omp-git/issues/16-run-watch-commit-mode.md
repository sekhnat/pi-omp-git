# 16: `run_watch` commit mode with late-run stabilization

**What to build:** Omitting `run` watches all workflow runs for a commit: an explicit `commit` (SHA) or `pr` parameter, else the head SHA of the session's last checkout, else current HEAD. Discovery is SHA-oriented — not branch-oriented — so PR-triggered and tag-triggered workflows are found. When no runs appear within the 90-second no-runs timeout, the watch returns that outcome. Before declaring success on all-green, the watcher stabilizes: it waits one additional poll interval, fetches again, and succeeds only if no new runs appeared and all observed runs remain successful — so late-arriving workflows are not missed. A single PR only — arrays are rejected.

**Blocked by:** 15 (`run_watch` run mode), 13 (`pr_push` with last-checkout resolution).

**Status:** ready-for-agent

- [ ] Commit mode: explicit `commit` or `pr`, else the last checkout's head SHA, else current HEAD; arrays are rejected
- [ ] Run discovery is SHA-oriented; a PR- or tag-triggered workflow for the commit is found
- [ ] No runs within 90 seconds yields the no-runs timeout outcome (injected time in tests)
- [ ] Late-run stabilization: after all observed runs are green, one extra poll happens; success only if no new runs appeared and everything remains successful
- [ ] A commit with several runs aggregates all of their outcomes