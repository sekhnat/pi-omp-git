# 15: `run_watch` run mode

**What to build:** `github {op: "run_watch", run: "1234567"}` (or an Actions run URL) watches a specific GitHub Actions run to completion, streaming progress updates while it polls. The polling engine uses the parity cadences — 3-second initial interval, fast window of 60 seconds, 15-second slow interval — with a 5-poll-failure budget that treats rate-limit errors as transient, and honors cancellation by terminating the underlying requests. success/neutral/skipped count as success; failure, timeout, cancellation, action-required, and startup-failure count as failures, with a 5-second grace period after the first failed job is detected and a refetch that collects contemporaneous failures together. Failed jobs get their captured logs inlined as a tail (default 15 lines, max 200) with the full captured logs persisted as file artifacts and referenced from the result; a log-download failure never fails the watch itself.

**Blocked by:** 08 (`github` dispatcher with `repo_view` and `file_read`).

**Status:** ready-for-human

- [x] Run ID and Actions URL forms both work; a URL/repo conflict errors rather than operating on the wrong repository
- [x] Poll cadences are exact: 3s for the first 60s, 15s after; time is injected in tests, never slept
- [x] Completion semantics: success/neutral/skipped succeed; all failure-like outcomes are detected
- [x] The failure grace period waits 5 seconds and refetches so parallel failures appear together
- [x] Failed jobs: captured log tail inlined (15 default, max 200); full captured logs persisted as artifacts with the reference returned; a log-download failure yields "Log unavailable" without failing the watch
- [x] Streaming progress updates flow during the watch, and the final result is valid plain text without rich rendering
- [x] AbortSignal cancellation stops polling and terminates child processes; the poll-failure budget treats rate-limit errors as transient

## Comments

**Implemented** (tickets 15–16 phase): `src/github/operations/run-watch.ts` —
`parseRunIdentifier` (run ID or Actions run URL with optional attempts suffix),
`checkRunUrlRepoConflict` (D3 pattern), `watchActions` polling engine with an
injected `WatchClock` (virtual time in tests, never slept): 3s initial
interval, 60s fast window, 15s slow interval, 5 consecutive-poll-failure
budget with rate-limit stderr mapped to `ActionsRateLimitError` and other
failures to `ActionsWatchError` (transient failures recover and reset the
budget). Completion semantics: success/neutral/skipped succeed;
failure/timed_out/cancelled/action_required/startup_failure fail. On first
failed job while the watch is still live: immediate update, 5s grace, refetch
collecting contemporaneous failures. Final collection inlines failed-job log
tails (default 15, max 200, `tail` param floored/clamped at the dispatcher)
and persists full captured logs under the configurable artifacts root
(`<agentDir>/artifacts/pi-omp-git/`), returning the path; a log-download
failure yields "Log unavailable." without failing the watch. AbortSignal is
honored at the loop top, in `gh` spawn options (terminates child processes),
and in sleeps. Progress streams via the tool update callback; the final
result is plain text. Tests: `test/run-watch.test.ts` (21 tests) plus a
dispatcher-level integration test in `test/github-dispatcher.test.ts`.
