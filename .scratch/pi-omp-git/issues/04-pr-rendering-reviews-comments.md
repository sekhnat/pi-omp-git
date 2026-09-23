# 04: `pr://` rendering with reviews and comment suppression

**What to build:** `read pr://123` renders the complete pull request: metadata (state, draft, author, base/head, review decision, merge state, labels, URL), body, a capped files preview, reviews, line-level review comments with thread relationships, and ordinary conversation comments. A PR that has review comments but no conversation comments still renders the reviews. `?comments=0` (or `false`) suppresses the expensive discussion material while preserving core metadata and the file summary — and the flag participates in the cache identity so the two variants are distinct rows.

**Blocked by:** 03 (Configuration layering and the SQLite cache).

**Status:** ready-for-human

- [x] `read pr://123` renders all required sections from the glossary's PR representation
- [x] Review comments are collected separately from ordinary comments, paginated at 100 per page, with replies retaining enough metadata to show thread relationships
- [x] A PR with review comments but zero conversation comments renders the review sections
- [x] `?comments=0` and `?comments=false` omit ordinary comments, review comments, and other expensive discussion material while preserving metadata and the file summary
- [x] The comments flag is part of the cache identity — flipping it produces a distinct cache row
- [x] Minimized comments are excluded

## Comments

- Implemented 2026-07 (ticket 04). PR fetch normalized in `src/github/resources/prs.ts` — one `gh pr view <N> -R owner/repo --json …` call carries metadata + files + reviews + conversation comments (legacy retry on unknown fields per §11, minimized comments filtered), and line-level review comments are collected separately through `gh api repos/{owner}/{repo}/pulls/{number}/comments?per_page=100 --paginate --slurp` (§13). With `?comments=0|false` the view call omits the `reviews`/`comments` fields and the review-comments call never runs (§14). Renderer in `src/github/resources/render.ts` (`renderPullRequest` + `renderReviewComments`): full metadata block, body, 50-file preview with overflow note, reviews, review comments with `↳ (reply to …)` thread markers, ordinary comments, and a `## Diff` pointer section; suppression keeps metadata + files only. Router `case "pr"` mirrors the issue case — local repo resolution, cache `readThrough` with the comments flag in the identity (distinct rows per variant), stale-notice wrapping, native pagination.
- Verification: `npm test` (vitest, 81 passing — 12 new in `test/pr-read.test.ts` covering every acceptance checkbox plus suppression-during-legacy-retry, and the obsolete "PR not implemented yet" guardrail in `test/issue-read.test.ts` flipped to a ticket-04 rendering guardrail), `npm run typecheck` clean, `biome check` clean.
- Inline code review (sub-agent lanes unavailable — runner infrastructure failed twice; owner chose inline): fixed the §14 leak where the §11 legacy retry re-requested `reviews,comments` on suppressed reads (`PR_FIELDS_LEGACY_NO_COMMENTS`), and §12's `Draft:` line now always renders (`yes`/`no`). Standards axis: one Duplicated-Code judgement call (gh-error classification mirrors `issues.ts`; extract when ticket 05/07 reuse it), no hard violations.
