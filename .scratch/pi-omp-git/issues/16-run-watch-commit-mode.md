# 16: `run_watch` commit mode with late-run stabilization

**What to build:** Omitting `run` watches all workflow runs for a commit: an explicit `commit` (SHA) or `pr` parameter, else the head SHA of the session's last checkout, else current HEAD. Discovery is SHA-oriented — not branch-oriented — so PR-triggered and tag-triggered workflows are found. When no runs appear within the 90-second no-runs timeout, the watch returns that outcome. Before declaring success on all-green, the watcher stabilizes: it waits one additional poll interval, fetches again, and succeeds only if no new runs appeared and all observed runs remain successful — so late-arriving workflows are not missed. A single PR only — arrays are rejected.

**Blocked by:** 15 (`run_watch` run mode), 13 (`pr_push` with last-checkout resolution).

**Status:** ready-for-human

- [x] Commit mode: explicit `commit` or `pr`, else the last checkout's head SHA, else current HEAD; arrays are rejected
- [x] Run discovery is SHA-oriented; a PR- or tag-triggered workflow for the commit is found
- [x] No runs within 90 seconds yields the no-runs timeout outcome (injected time in tests)
- [x] Late-run stabilization: after all observed runs are green, one extra poll happens; success only if no new runs appeared and everything remains successful
- [x] A commit with several runs aggregates all of their outcomes

## Comments

**Implemented**: commit mode in `watchActions` — SHA resolution order
explicit `commit` → explicit `pr` (`gh pr view --json headRefOid`) → the
session's last checkout (`git rev-parse refs/heads/<branch>`) → current
HEAD; arrays of `pr` are rejected at the dispatcher. Discovery is
SHA-oriented via `gh run list --commit <sha> -R <repo>`, so PR- and
tag-triggered workflows are found. When no runs appear within the 90-second
no-runs timeout the watch returns that outcome. Before declaring success on
all-green the watcher stabilizes: one additional poll interval, refetch of
the run list; success only if no new run IDs appeared and all observed runs
remain successful — otherwise it keeps watching (and a run that flips to
failure during stabilization takes the failure path with grace and logs).
Several runs aggregate into `details.runs` with per-run outcomes. Tests:
`test/run-watch.test.ts`.
