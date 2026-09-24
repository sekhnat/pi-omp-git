# 13: `pr_push` with last-checkout resolution

**What to build:** `github {op: "pr_push"}` pushes a PR branch back to its PR — and after a checkout, the agent can say just that with no arguments. The target resolves in order: an explicit `pr` (text) or `branch` parameter; else the session's **last checkout** (the most recent `pr_checkout` in this session, derived from the session transcript so it survives resume); else current-branch metadata; else a clear error. A branch without checkout metadata yields the deterministic "no PR checkout metadata — use pr_checkout before pr_push" error; a contributor branch is never guessed. The push goes exactly to the PR head ref (from HEAD when the branch is checked out, else from the ref), supports `--force-with-lease` only (plain force never), surfaces remote rejection without converting it to a force push, and on success invalidates that PR's cached views and diffs. A single PR only — arrays are rejected.

**Blocked by:** 11 (`pr_checkout` single PR with managed worktree and mutation lock), 03 (Configuration layering and the SQLite cache).

**Status:** ready-for-human

- [x] Missing branch metadata produces the deterministic metadata error; no contributor-branch guessing
- [x] Resolution order: explicit parameter → last checkout (survives session resume) → current-branch metadata → error; arrays are rejected
- [x] The pushed ref is exactly the PR head ref; checked-out branches push from HEAD, others from the branch ref
- [x] `forceWithLease` maps to `--force-with-lease`; plain `--force` is never used
- [x] A successful push invalidates the PR's cached PR and PR-diff rows
- [x] Remote rejection is surfaced as an error, never converted to a force push
- [x] Pushes work for current and non-current PR branches, same-repo and fork PRs

## Comments

**Implemented**: `src/github/operations/pr-push.ts` (resolution explicit
`pr`/`branch` → session last checkout → current-branch metadata → error;
deterministic `PrMetadataMissingError`; exact refspec `<source>:refs/heads/<ompPrHeadRef>`
with HEAD only when the branch is checked out; `--force-with-lease` only;
remote rejection surfaced, never forced; successful push invalidates pr +
pr-diff rows both comment modes) and `src/github/last-checkout.ts`
(transcript-derived record; survives resume via `pi.appendEntry` +
`sessionManager.getBranch()`). Tests: `test/pr-push.test.ts` (real git).
