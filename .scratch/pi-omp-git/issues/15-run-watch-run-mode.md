# 15: `run_watch` run mode

**What to build:** `github {op: "run_watch", run: "1234567"}` (or an Actions run URL) watches a specific GitHub Actions run to completion, streaming progress updates while it polls. The polling engine uses the parity cadences — 3-second initial interval, fast window of 60 seconds, 15-second slow interval — with a 5-poll-failure budget that treats rate-limit errors as transient, and honors cancellation by terminating the underlying requests. success/neutral/skipped count as success; failure, timeout, cancellation, action-required, and startup-failure count as failures, with a 5-second grace period after the first failed job is detected and a refetch that collects contemporaneous failures together. Failed jobs get their captured logs inlined as a tail (default 15 lines, max 200) with the full captured logs persisted as file artifacts and referenced from the result; a log-download failure never fails the watch itself.

**Blocked by:** 08 (`github` dispatcher with `repo_view` and `file_read`).

**Status:** ready-for-agent

- [ ] Run ID and Actions URL forms both work; a URL/repo conflict errors rather than operating on the wrong repository
- [ ] Poll cadences are exact: 3s for the first 60s, 15s after; time is injected in tests, never slept
- [ ] Completion semantics: success/neutral/skipped succeed; all failure-like outcomes are detected
- [ ] The failure grace period waits 5 seconds and refetches so parallel failures appear together
- [ ] Failed jobs: captured log tail inlined (15 default, max 200); full captured logs persisted as artifacts with the reference returned; a log-download failure yields "Log unavailable" without failing the watch
- [ ] Streaming progress updates flow during the watch, and the final result is valid plain text without rich rendering
- [ ] AbortSignal cancellation stops polling and terminates child processes; the poll-failure budget treats rate-limit errors as transient