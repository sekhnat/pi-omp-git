# 05: PR diff primary resources

**What to build:** The three PR diff resources work: `pr://N/diff` renders the changed-file index (1-based, stable ordering), `pr://N/diff/I` returns exactly file I's diff section, and `pr://N/diff/all` returns the full unified diff. All three derive from one cached, normalized diff object — a single network fetch serves repeated reads of any view while the row is valid. Section boundaries come from parsing the unified diff (modified, added, deleted, renamed, binary), and slices use string indices into the cached diff, not byte offsets. Native pagination discipline (truncation caps, continuation notices, out-of-range errors) and the version-change notice apply to all three views.

**Blocked by:** 04 (`pr://` rendering with reviews and comment suppression).

**Status:** ready-for-human

- [x] `/diff` renders the 1-based index in stable order; `/diff/I` returns exactly section I; `/diff/all` returns the unified diff
- [x] Repeated reads across the three views trigger one fetch while the cache row is valid
- [x] Index entries carry string-index section boundaries into the cached unified diff; non-ASCII diffs slice correctly
- [x] Parsing recognizes modified, added, deleted, renamed, and binary files
- [x] All three views honor native pagination discipline and emit the update notice when the row version changes between paginated reads
- [x] Fixtures cover one-file, multi-file, new, deleted, rename, and binary diffs

## Comments

- Implemented in `src/github/resources/diffs.ts`: `gh pr diff N --color never --repo owner/repo` fetch; verbatim unified diff plus ordered, 1-based file index with UTF-16 `startIndex`/`endIndex`; modified/added/deleted/renamed/binary classification; index, file-section, and full-diff renderings. Router caches the serialized normalized object once under the shared `pr-diff` identity, then paginates each selected view. Session version notices are emitted before paginated content when the row changes.
- Fixed cache persistence to key repository rows by canonical `owner/repo`; a regression test proves same-named repositories under different owners cannot share a PR diff row.
- Verification: `npm test` (96 passing), `npm run typecheck` clean, and `./node_modules/.bin/biome check .` clean. Added 15 acceptance tests in `test/pr-diff.test.ts` for all three views, cached fetch sharing, Unicode/quoted filenames, file types, owner isolation, pagination and version changes, and bare/Enterprise repo resolution.
- Inline code review vs `85122e7`: fixed parsing for valid unquoted filenames containing ` b/` and Git's tab-delimited `---`/`+++` marker suffixes; added regression coverage. Standards: one Duplicated-Code judgement call for the isolated test fixture builder; no hard standards breaches. Spec: one finding fixed; no residual findings.
