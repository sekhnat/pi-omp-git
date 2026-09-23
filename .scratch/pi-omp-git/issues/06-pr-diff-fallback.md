# 06: PR diff fallback for large diffs

**What to build:** When GitHub rejects the aggregate diff because it is too large, the diff resources still work: the changed-file list is fetched through the API and paginated, available per-file patch bodies are assembled into a deterministic synthetic unified representation, and files GitHub provides no patch for are represented with an explicit unavailability marker — the PR read never fails solely because one file has no patch. The hard boundary is honest: when the changed-file list exceeds the API's 3,000-file limit, the fallback fails with a clear error naming the limit rather than silently truncating.

**Blocked by:** 05 (PR diff primary resources).

**Status:** ready-for-human

- [x] An aggregate-diff rejection triggers the per-file fallback, which renders the same three views as the primary path
- [x] Files without patches render the explicit unavailable marker; the read succeeds
- [x] A PR whose changed-file list exceeds 3,000 files fails with a clear error naming the limit and the PR — never a silent truncation
- [x] The synthetic representation is deterministic (stable ordering, stable markers)
- [x] Fixtures cover: unavailable per-file patch, aggregate rejection, and the over-limit boundary

## Comments

- `gh pr diff` HTTP 406 now triggers the fallback: query `changed_files`, reject counts above 3,000, then paginate `repos/{owner}/{repo}/pulls/{number}/files` in 100-file pages. Exactly 3,000 is accepted only when the independent count confirms the listing is complete.
- Available patches are assembled in filename-sorted order as synthetic unified sections. Missing patch bodies get `Patch unavailable from GitHub for this file.` in the index and section; the read still succeeds, and all three views remain on the same cached normalized object.
- Inline review against `6f17d7b`: no remaining Standards or Spec findings.
- Verification: `npm test` (101 passing), `npm run typecheck` clean, and `./node_modules/.bin/biome check .` clean.
