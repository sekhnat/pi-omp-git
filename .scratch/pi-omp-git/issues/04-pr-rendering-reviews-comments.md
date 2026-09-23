# 04: `pr://` rendering with reviews and comment suppression

**What to build:** `read pr://123` renders the complete pull request: metadata (state, draft, author, base/head, review decision, merge state, labels, URL), body, a capped files preview, reviews, line-level review comments with thread relationships, and ordinary conversation comments. A PR that has review comments but no conversation comments still renders the reviews. `?comments=0` (or `false`) suppresses the expensive discussion material while preserving core metadata and the file summary — and the flag participates in the cache identity so the two variants are distinct rows.

**Blocked by:** 03 (Configuration layering and the SQLite cache).

**Status:** ready-for-agent

- [ ] `read pr://123` renders all required sections from the glossary's PR representation
- [ ] Review comments are collected separately from ordinary comments, paginated at 100 per page, with replies retaining enough metadata to show thread relationships
- [ ] A PR with review comments but zero conversation comments renders the review sections
- [ ] `?comments=0` and `?comments=false` omit ordinary comments, review comments, and other expensive discussion material while preserving metadata and the file summary
- [ ] The comments flag is part of the cache identity — flipping it produces a distinct cache row
- [ ] Minimized comments are excluded
