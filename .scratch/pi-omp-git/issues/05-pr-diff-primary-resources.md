# 05: PR diff primary resources

**What to build:** The three PR diff resources work: `pr://N/diff` renders the changed-file index (1-based, stable ordering), `pr://N/diff/I` returns exactly file I's diff section, and `pr://N/diff/all` returns the full unified diff. All three derive from one cached, normalized diff object — a single network fetch serves repeated reads of any view while the row is valid. Section boundaries come from parsing the unified diff (modified, added, deleted, renamed, binary), and slices use string indices into the cached diff, not byte offsets. Native pagination discipline (truncation caps, continuation notices, out-of-range errors) and the version-change notice apply to all three views.

**Blocked by:** 04 (`pr://` rendering with reviews and comment suppression).

**Status:** ready-for-agent

- [ ] `/diff` renders the 1-based index in stable order; `/diff/I` returns exactly section I; `/diff/all` returns the unified diff
- [ ] Repeated reads across the three views trigger one fetch while the cache row is valid
- [ ] Index entries carry string-index section boundaries into the cached unified diff; non-ASCII diffs slice correctly
- [ ] Parsing recognizes modified, added, deleted, renamed, and binary files
- [ ] All three views honor native pagination discipline and emit the update notice when the row version changes between paginated reads
- [ ] Fixtures cover one-file, multi-file, new, deleted, rename, and binary diffs
