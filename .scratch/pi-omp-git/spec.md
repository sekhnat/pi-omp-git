# pi-omp-git — OMP Git/GitHub parity package for upstream Pi

Status: ready-for-agent

## Problem Statement

I use upstream Pi. Oh My Pi has materially better Git and GitHub ergonomics than plain Pi: issues, PRs, and diffs are native readable resources; PR inspection happens in isolated worktrees that never touch my primary checkout; CI runs are watched to completion; commit messages are composed agentically. Without those, my agent scrapes GitHub HTML or shells out to `gh`, copies PR bodies around by hand, risks mutating my working checkout just to look at a PR, misses late-arriving CI runs, and produces unstructured commit messages. Getting those capabilities today means leaving upstream Pi to run OMP.

## Solution

A Pi package, `pi-omp-git`, that reproduces OMP's Git and GitHub capabilities natively inside upstream Pi, without forking it. After `pi install`, the agent gains:

- **read-only resources**: `issue://` and `pr://` URIs (and PR diff resources) read through the normal `read` tool with native pagination and truncation behavior;
- **a `github` dispatcher tool** for repository inspection, file reads, five searches, PR creation, isolated PR checkout, PR push, and Actions watching;
- **an interactive `/git` TUI** with staging, hunk operations, revision inspection, and a commit composer;
- **AI Stage** (natural-language staging plans) and an **agentic `/commit` pipeline** (single or split commits, changelog integration, dry-run, optional push).

Where the design is deliberately safer than current OMP, the difference is recorded in a divergence register rather than silently contradicting the parity goal. The flagship interaction — "look at PR 418, fix the requested issue, push it back, watch CI" — works naturally, with no manual PR-body copying, HTML scraping, primary-checkout mutation, fork-remote discovery, or workflow-ID hunting.

## User Stories

1. As a Pi user, I want my agent to read GitHub issues through `issue://` URIs, so that issue content arrives as a native resource instead of scraped HTML.
2. As a Pi user, I want to list issues via bare `issue://` and repository-scoped URIs with `state`, `limit`, `author`, and `label` filters, so that I can browse without leaving the conversation.
3. As a Pi user, I want my agent to read PRs through `pr://` URIs including body, files, reviews, review comments, and conversation comments, so that full PR context is one read away.
4. As a Pi user, I want `pr://N/diff` (changed-file index), `pr://N/diff/I` (one file's section), and `pr://N/diff/all` (unified diff) as separate resources, so that my agent reads only the diff slice it needs.
5. As an agent, I want `offset`/`limit` pagination on virtual resources to behave exactly like native file reads — same truncation caps, continuation notices, and out-of-range errors — so that I can consume them with the same discipline.
6. As an agent, I want a visible notice when a resource I was paginating has been refreshed to a new version, so that I can restart pagination instead of silently reading shifted lines.
7. As a Pi user, I want `?comments=0` to suppress expensive discussion material on single-resource reads, so that huge PR threads stay affordable.
8. As a GitHub Enterprise user, I want host-qualified URIs and `host/owner/repo` repository identifiers, so that Enterprise repositories are first-class, never aliased to github.com.
9. As a user with multiple GitHub accounts, I want cached content keyed by a credential fingerprint, so that private content never leaks between identities on the same machine.
10. As a Pi user, I want reads served from a cache with a 5-minute soft TTL and 7-day hard TTL, so that repeated reads are fast and cheap.
11. As a Pi user, I want stale content served with a warning when a synchronous refresh fails, so that I know what I am looking at.
12. As a Pi user, I want stale PR diffs to refresh in a deduplicated background job, so that large diffs do not block my read.
13. As an agent, I want GitHub searches (issues, PRs, code, commits, repositories) with agent-useful rendering and canonical URLs, so that I can find things without scraping search pages.
14. As an agent, I want searches default-scoped to the current repository unless my query already declares a scope, so that "find the bug about X" means the repo I am working in.
15. As an agent, I want relative (`3m`, `12h`, `7d`, `2w`, `3mo`, `1y`) and absolute date filters with `created`/`updated` field selection, so that I can express time windows naturally.
16. As an agent, I want search results bounded (default 10, max 50) with non-finite, non-positive, and over-max limits rejected or clamped, so that one bad query cannot flood my context.
17. As an agent, I want `repo_view` to return description, default branch, visibility, permissions, language, stars, forks, archived and fork status, and topics, so that I can orient in an unfamiliar repository.
18. As an agent, I want `file_read` for files stored in GitHub repositories — text decoded properly, images as image content, other binaries as metadata plus source URL — so that I never reach for `curl` or `wget`.
19. As a PR contributor, I want `pr_create` with an explicit title, or `fill: true` to have title and body generated from the change, so that creating PRs is one operation either way.
20. As a PR contributor, I want PR bodies passed via a temporary body file and an explicitly empty body to stay noninteractive, so that `gh` never unexpectedly opens an editor.
21. As a PR contributor, I want a post-create refresh failure to never turn a successfully created PR into an error, so that the operation reports what actually happened.
22. As a maintainer, I want `pr_checkout` to place every PR in a dedicated managed worktree and never mutate my current checkout, so that inspecting a PR is risk-free.
23. As an agent, I want the checkout result to prominently carry the worktree path, so that I can edit files there via absolute paths.
24. As an agent, I want batch `pr_checkout` to permit partial success — successful worktrees reported alongside structured per-PR failures — so that one bad PR does not block the rest.
25. As an agent, I want a 0-for-N batch checkout to return an error, so that I never mistake total failure for success.
26. As a maintainer, I want an existing `pr-N` branch reused when it matches the PR head, and a clear conflict — never a silent reset — when it does not, unless I explicitly force, so that local state is never clobbered.
27. As a maintainer reviewing fork PRs, I want fork head repositories resolved to push-capable remotes that match my origin's transport (HTTPS/SSH), so that pushes keep my authentication model.
28. As a PR contributor, I want checkout to persist OMP-compatible branch metadata (head ref, PR URL, cross-repository and maintainer-can-modify flags), so that later pushes are deterministic and OMP users can interoperate.
29. As an agent, I want `pr_push` to resolve its target by explicit parameter, then the session's last checkout, then current-branch metadata — and to accept a single PR — so that "push it back" works without ambiguity after a checkout.
30. As a PR contributor, I want `pr_push` to push exactly to the PR head ref using `--force-with-lease` when forced, never plain `--force`, so that I can never destroy someone else's branch by accident.
31. As an agent, I want a successful push to invalidate that PR's cached views and diffs, so that my next read reflects what I just pushed.
32. As a CI-watching user, I want `run_watch` by run ID or Actions URL, or in commit mode for a commit (explicit, or the last checkout's head), so that I can monitor exactly the runs I mean.
33. As a CI-watching user, I want commit-mode watch to be SHA-oriented and to wait one extra poll after all runs look green, so that late-arriving workflows are not missed.
34. As a CI-watching user, I want failed jobs surfaced immediately with a failure grace period that collects contemporaneous failures, so that parallel failures appear together.
35. As a CI-watching user, I want failed-job logs inlined as a tail (default 15, max 200 lines) with the captured full logs persisted as artifacts, so that I see the error without flooding context.
36. As a CI-watching user, I want streaming progress updates during the watch with a valid plain-text final result, so that the tool works with or without rich rendering.
37. As a Pi user, I want mutations I make through the shell `gh` (issue close, PR merge, comments, reviews) to invalidate relevant cache rows before the command even runs, so that my next read is not stale.
38. As a Pi user, I want cache invalidation to deliberately over-invalidate rather than leave stale content, so that correctness beats cleverness.
39. As a Pi user, I want the extension to keep working (Git-only) when `gh` is missing or unauthenticated, with clear dependency errors for GitHub surfaces, so that availability degrades gracefully.
40. As a Pi user, I want stable, friendly error messages for the common failures (no `gh`, no auth, no repository context, invalid JSON) without stack traces or echoed tokens, so that failures are actionable.
41. As a Pi user, I want an interactive `/git` UI showing staged, unstaged, and conflicted files with a side-by-side diff, so that I can review and shape changes without leaving Pi.
42. As a Pi user, I want file-level stage, unstage, and discard operations with explicit confirmation for destructive discards — including a warning that unstaged modifications on the same path will be lost — so that I never destroy work by accident.
43. As a Pi user, I want hunk-level stage, unstage, and discard driven by validated Git patch primitives, so that partial changes are applied exactly and never reported as success when partially applied.
44. As a Pi user, I want conflicted files protected from ordinary file operations, so that conflict resolution is deliberate.
45. As a Pi user, I want revision inspection mode (read-only, parent-versus-revision diffs, mutations disabled), so that I can study any commit.
46. As a Pi user, I want large files (over 4 MiB) and binary files handled with clear status instead of content previews, so that the UI stays responsive.
47. As a Pi user, I want a commit composer with manual entry, AI-generated Conventional Commits messages I can edit, and amend mode, so that commits are well-formed by default.
48. As a Pi user, I want AI Stage: a natural-language instruction ("stage only the retry-handling changes") produces a staging plan of files/hunks that I confirm before anything stages, so that selective staging is not manual labor.
49. As a Pi user, I want AI staging to snapshot the index before applying and verify the intended hunks are staged (and rejected hunks are not) after, so that a failed plan never corrupts my state.
50. As a Pi user, I want `/commit` to analyze my staged changes (plus working tree in compatibility mode, reported) and create exactly the intended commit(s), so that committing is one command.
51. As a Pi user, I want unrelated changes split into multiple coherent commits, with the plan displayed for confirmation (configurable: confirm/auto/never), so that history tells the true story.
52. As a Pi user, I want `--dry-run` to print the full plan — messages, grouping, changelog entry — while touching neither index nor working tree, so that I can preview safely.
53. As a Pi user, I want all commit hooks to run normally with their stderr preserved on rejection, so that repository policy is respected.
54. As a Pi user, I want repository and user GPG signing configuration respected (no fake pinentry workarounds, no silent signing downgrade), so that signed-commit workflows keep working.
55. As a Pi user, I want changelog integration (opt-out via `--no-changelog`) that proposes an entry and includes it in an appropriate commit, so that release notes stay current.
56. As a Pi user, I want `--push` to push only after commits succeed, using the PR push routing on PR branches and normal upstream otherwise, and never converting a non-fast-forward rejection into a force push, so that pushing is safe.
57. As a Pi user, I want a failed or interrupted split to stop at the failure, report what succeeded, and leave all uncommitted changes recoverable, so that I never lose work to a bad proposal.
58. As a Pi user, I want command success verified against actual repository state (HEAD moved) rather than proposal output, so that "looked successful but never committed" bugs are impossible.
59. As a Pi user, I want configuration in a user file and a project file (read only after project trust), layered over safe defaults, so that behavior is tunable per project without surprises.
60. As a headless/CI user, I want the GitHub surfaces to work without a TTY and the companion binary to offer the same git/commit pipelines standalone, so that automation gets the same capabilities.

## Implementation Decisions

**Package shape and loading**

- The package is loadable by Pi through the `pi` manifest in its package manifest (extension entry point plus the `pi-package` keyword); it declares the same Node engine floor as Pi (22.19).
- A companion executable offers `git` and `commit` subcommands for standalone-command parity; it reuses the same published TUI component library Pi uses. One pipeline implementation serves both hosts: the in-Pi commands run it in-process; the binary runs it standalone.
- The package requires `git` and `gh` on PATH; GitHub operations use the user's existing `gh` authentication — no independent token store. When `gh` is unavailable, Git functionality continues and GitHub surfaces return dependency errors.

**Divergence posture (ADR 0001)**

- Where the design is deliberately safer than current OMP, the difference is recorded in a divergence register, and the parity definition means "OMP behavior except where the register says otherwise". The registered divergences: dry-run never stages (OMP stages even in dry-run); wrong-SHA PR branches fail unless forced (OMP reuses silently); PR-URL vs explicit repo conflicts error (OMP drops the repo flag); a 0-for-N batch checkout is an error (OMP reports success); the analyze-files fan-out is capped by configuration (OMP is uncapped). Log capture is not a divergence — both sides cap at 8 MiB; only the wording ("captured", never "complete") differs.

**Read override and read-only resources**

- The extension overrides Pi's built-in `read` by delegation: virtual URIs route to the GitHub resource router; everything else delegates to the native tool unchanged.
- Virtual resources are **read-only** (no write operations exist through the scheme; server-side content may change and cached representations refresh). The old "immutable" wording is retired.
- Rendered content obeys the native read discipline exactly: pagination semantics, the native line/byte truncation caps, continuation notices, and out-of-range errors. Pagination slices the **rendered snapshot** bound to the current cache row; a refresh swaps the row for future reads. When a paginated read lands on a different row version than the one last served for that resource in the session, the result begins with an update notice.
- The URI grammar covers bare, repository-scoped, and host-qualified forms for issues and PRs; diff file indices are 1-based; validation rejects traversal segments, non-positive numbers, bad percent-encoding, invalid diff indices, and unexpected suffixes.
- Listing resources accept `state`, `limit` (clamped at 100), `author`, and `label`; lists are fetched live rather than cached. `?comments=0` suppresses discussion material and participates in the cache identity.
- Minimized comments are excluded; unsupported JSON fields on older `gh` versions trigger a retry with the field omitted.

**Cache**

- SQLite via the built-in `node:sqlite` module (available unflagged on every Node version Pi supports), probed at startup; on failure the extension degrades to uncached operation. No native (node-gyp) dependency is acceptable. A corrupted database must never make GitHub unusable.
- Rows are scoped by credential fingerprint (a SHA-256 digest of available credential material — never the token itself), host, repository, resource kind, number, and comments mode.
- Freshness: soft TTL 300s (serve cached), between soft and hard TTL (synchronously refresh, fall back to stale-with-warning; PR diffs instead serve stale and schedule a deduplicated background refresh), beyond hard TTL (evict and fetch).
- Invalidations are proactive on known mutations: this extension's own operations invalidate after confirmed success; observed shell commands containing recognizable `gh` mutation verbs (from `bash` tool results and interactive `!` commands) invalidate **before** execution — detection, not success. The observable scope is stated: mutations outside Pi-observed commands are undetectable; TTL is the backstop. Over-invalidation is preferred to staleness.
- Cache directory and database use restrictive permissions (0700/0600) with WAL journaling.

**GitHub dispatcher tool**

- One `github` tool dispatches: `repo_view`, `file_read`, `pr_create`, `pr_checkout`, `pr_push`, `search_issues`, `search_prs`, `search_code`, `search_commits`, `search_repos`, `run_watch`.
- `pr` values are text (a number as a string, a PR URL, or a branch-like identifier); JSON numbers are rejected. The array form is valid for `pr_checkout` batching only — push and watch accept a single PR. Commit-mode watch accepts an explicit `commit` (SHA) or `pr`.
- All process execution goes through one centralized runner using argument arrays (never shell interpolation), with noninteractive environment settings, a 5-minute timeout, an 8 MiB output cap with honest truncation reporting, and cancellation that terminates the child.
- A stable error taxonomy classifies: GitHub unavailability, authentication, repository resolution, API errors; invalid resource URLs, not-found; checkout conflicts, missing PR metadata, worktree collisions; Git repository, mutation, and hook errors; Actions watch and rate-limit errors; commit proposal and execution errors. Tool-facing messages omit stack traces.

**PR checkout, push, and watching (ADRs 0002 and §110 of the reference spec)**

- Checkout never mutates the user's primary checkout; every PR lives in a managed worktree under a configurable root with collision-suffixed naming, detected primarily by branch reference rather than path.
- Local PR branches are named `pr-<number>`; branch metadata uses OMP-compatible keys so `pr_push` is deterministic and OMP users interoperate.
- Fork PRs resolve a push-capable head-repository remote (reusing an existing correct one, else a transport-matched `fork-<owner>` name).
- Batch checkout partial success: at least one success → successful result with structured `checkouts[]` and `failures[]` (each failure classified by the error taxonomy); zero successes → tool error with the same body.
- All Git mutations affecting shared repository metadata are serialized by primary repository root via an in-process mutex (MUST) plus an advisory lockfile in the repository's Git directory (SHOULD); the no-race guarantee is scoped to mutations issued through this extension.
- `pr_push` requires prepared branch metadata, pushes exactly to the PR head ref, uses `--force-with-lease` only, and never guesses a contributor branch. `run_watch` polling: 3s initial interval, 60s fast window, 15s slow interval, 90s no-runs timeout, 5 poll-failure budget, 5s failure grace period; polls honor the abort signal; rate-limit errors are transient until the budget is exhausted. Success-like outcomes are success/neutral/skipped; failure-like outcomes include failure, timeout, cancellation, action-required, and startup failure.
- The post-checkout workflow is param/metadata-driven because Pi cannot switch the session cwd: the agent edits via absolute paths under the returned worktree path; `pr_push`/`run_watch` resolve by explicit parameter, then the session's **last checkout** (derived from the session transcript so it survives resume), then current-branch metadata / current HEAD, else error.
- Actions failure logs are "captured" (bounded by the runner's 8 MiB cap), inlined as a tail, and persisted as file-based artifacts — Pi provides no artifact facility.
- Prompt guidance is appended via the system-prompt build hook, including the absolute-worktree-path guidance.

**Authorization (ADR 0003)**

- No extension-level approval gate in v0.1: mutations run with the same authority as every Pi tool. The spec states explicitly that OMP's read/exec approval parity is impossible in Pi. A future interactive confirmation gate is a recorded MAY. Destructive local Git operations remain gated by direct interactive intent.

**Agentic commit pipeline (ADR 0004)**

- The commit agent is a nested headless agent session created through the SDK with a worktree cwd and no built-in tools; its allowlist is the narrow surface: Git overview, per-file diff, precise hunk retrieval, file analysis fan-out, and the two proposal tools. Nested sessions use a temporary session directory and never appear in the user's session list. The default model is the current session's model unless overridden.
- The file-analysis fan-out is capped by configuration (enabled, max files, max concurrency).
- Split plans are **file-level** in this release: every selected path belongs to at most one commit; hunk-level assignment is a recorded non-goal; a file with unrelated concerns is placed in the dominant commit.
- Execution is transactional: snapshot index/tree/untracked state, build each group's index, commit in order, restore the intended residual state; every hook runs for every commit; a failure stops immediately, reports the boundary, and leaves uncommitted changes recoverable.
- Conservation is enforced by pre/post snapshot comparison; any mismatch — including hook side-effects or external concurrent modification — aborts with an execution error rather than proceeding silently.
- The correctness contract: a non-dry-run command must end in exactly one of "commits were actually created", "command returns failure", or "definitively no changes" — verified by HEAD movement, never by proposal output.
- Dry-run performs full analysis and prints the displayed plan (messages, grouping, changelog) while executing no commit and no push, and never touching the index or working tree.
- Changelog integration proposes an entry and commits it as part of an appropriate commit; absence of a changelog is not an error.
- Split policy (confirm/auto/never) is explicit and configurable; noninteractive behavior never depends on TTY detection.

**Interactive Git TUI and AI Stage**

- The `/git` UI maintains explicit model state (root, branch, HEAD, staged/unstaged/conflicted files, selection, revision mode) refreshed from actual repository state after every mutation — never inferred from process exit text.
- File-level operations: stage/unstage/discard with differentiated discard semantics (restore index and working tree, remove untracked when requested) and explicit destructive-intent confirmation; conflicted files are protected.
- Hunk-level operations use validated Git patch primitives with target-state verification; a partially applied patch is never reported as success.
- Revision mode is read-only. Ordinary diffable files over 4 MiB show status instead of content. Binary files show status without decoding; image previews are optional; SVG rasterization is resource-limited; LFS pointers are recognized.
- AI Stage runs as a nested agent session (read-only Git tools plus a staging-plan proposal tool); the user confirms the plan before staging; index snapshots and post-verification (intended hunks staged, rejected hunks unstaged, restore on halfway failure) are mandatory; AI staging never commits.

**Configuration**

- User configuration at the Pi agent directory (`pi-omp-git.json`) and project configuration under the project's Pi config directory (read only after project trust is granted), layered over defaults: cache TTLs, search limits, run-watch timing, tail lines, worktree root, TUI file-size cap, and the commit knobs (analysis caps, split policy, changelog, dry-run analysis toggle). Environment overrides exist for the worktree root and cache database path (with OMP migration aliases).

**Delivery**

- Phased: v0.1 ships the full GitHub interface (resources, diff, cache, Enterprise, repo_view, file_read, searches, pr_create, pr_checkout, pr_push, run_watch, invalidation); v0.2 adds the `/git` TUI; v0.3 adds AI Stage; v0.4 adds the agentic `/commit` pipeline. The differential parity harness against OMP is deferred until the GitHub surfaces stabilize; until then the divergence register records the normalization rules the harness will apply.

## Testing Decisions

- **What makes a good test here**: only external behavior is asserted — a `read` or `github` tool call goes in, a tool result comes out; repository state is verified with `git` itself; the TUI is tested through its headless state model (no terminal); no internal module structure is ever asserted. Fixtures are deterministic recorded data; time is injected for polling scenarios.
- **Assertion level**: the model-facing tool boundary (the read override and the github dispatcher), matching the acceptance-test inventory in the reference spec: virtual-resource reads (including Enterprise, private-repo isolation, and comment suppression), diff fixtures (renames, binaries, unavailable patches, the aggregate-diff fallback including the 3,000-file hard boundary), the cache matrix (fresh/soft/hard, refresh success and failure, background refresh dedup, multi-account and multi-host isolation, disabled, corrupt), checkout and push matrices (same-repo, fork, transports, existing correct/wrong branches, force, collisions, batches, simultaneous calls, refspec exactness), search behavior, Actions scenarios with injected time (late runs, rate limiting, abort), the TUI model mutations, and the commit invariants (structural split assertions — every changed file in exactly one commit or one coherent single commit — never the model's specific grouping).
- **Seams** (as confirmed):
  1. A **scripted `gh` runner** at the centralized process runner — the single new injection seam through which all GitHub I/O flows; fixtures map recorded argv to stdout/exit.
  2. **Real `git` in temporary directories** — never faked; checkout/push/commit tests assert final repository state.
  3. **Scripted nested-agent responses** at the nested-session boundary — deterministic proposal fixtures for the commit agent, AI Stage, and `pr_create` fill.
  4. **A real cache database on a temporary path** — actual SQLite, including the corrupt-database scenarios.
- **Prior art**: the sibling package in this repository family (a published Pi package with a vitest suite importing ESM source directly) establishes the runner and import style; the reference spec's acceptance-test sections provide the scenario inventory; correctness tests for the commit pipeline assert the "no non-dry-run success without repository-state proof" absolute invariant.

## Out of Scope

- Non-GitHub forges: GitLab, Bitbucket, Gitea/Forgejo, and generic forge auto-detection.
- `issue_create`, and PR merge/close/comment/review/edit as first-class `github` operations (the shell `gh` path remains available).
- Mutation through `issue://` or `pr://` — the URI schemes are read-only by definition.
- Any extension-level approval/confirmation gate for GitHub mutations (recorded MAY).
- A `/pr <n>` command that opens a nested interactive session in the worktree (recorded MAY; the session cwd cannot be switched without forking Pi).
- Managed-worktree lifecycle operations: no removal or garbage-collection command in this release (manual removal is documented); a `pr_worktree_remove` operation is a recorded MAY.
- Hunk-level split-commit assignment (file-level only; recorded non-goal).
- The differential parity harness against OMP in v0.1 (deferred; normalization rules live in the divergence register).
- Plain `--force` push (never; `--force-with-lease` only).
- Interactive features requiring a TTY are not adapted to non-TTY contexts; they simply require one.

## Further Notes

- The full requirements live in the amended reference specification (`docs/pi-omp-git-reference.md`, 111 sections including the divergence register, authorization model, post-checkout workflow, and worktree-lifecycle sections). The four ADRs (`docs/adr/0001`–`0004`) record the load-bearing decisions: safer-by-default with a divergence register; param/metadata-driven post-checkout workflow; no mutation approval gate; commit agent in nested headless sessions. `CONTEXT.md` is the normative glossary — its vocabulary (read-only resource, rendered snapshot, divergence, managed worktree, PR branch, last checkout, partial success, dry-run, commit agent, nested agent session) should name the code's concepts. `EXPLORE.md` is the historical review that drove the amendments.
- If engineering time is constrained, the implementation priority is: read override plus `issue://`/`pr://`, PR diff cache, checkout/push, searches, run_watch, file_read/repo_view/pr_create, then the TUI, AI Stage, and `/commit`. Items one through six deliver nearly all of the value an agent feels moving from ordinary Pi to the OMP GitHub workflow; the TUI and commit command are separable.
- OMP-compatibility notes for migration: branch metadata keys, the worktree-root and cache-database environment overrides, and the OMP worktree naming scheme are all deliberate, so users migrating from OMP keep their state.
