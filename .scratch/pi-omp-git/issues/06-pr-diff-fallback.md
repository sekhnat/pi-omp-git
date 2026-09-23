# 06: PR diff fallback for large diffs

**What to build:** When GitHub rejects the aggregate diff because it is too large, the diff resources still work: the changed-file list is fetched through the API and paginated, available per-file patch bodies are assembled into a deterministic synthetic unified representation, and files GitHub provides no patch for are represented with an explicit unavailability marker — the PR read never fails solely because one file has no patch. The hard boundary is honest: when the changed-file list exceeds the API's 3,000-file limit, the fallback fails with a clear error naming the limit rather than silently truncating.

**Blocked by:** 05 (PR diff primary resources).

**Status:** ready-for-agent

- [ ] An aggregate-diff rejection triggers the per-file fallback, which renders the same three views as the primary path
- [ ] Files without patches render the explicit unavailable marker; the read succeeds
- [ ] A PR whose changed-file list exceeds 3,000 files fails with a clear error naming the limit and the PR — never a silent truncation
- [ ] The synthetic representation is deterministic (stable ordering, stable markers)
- [ ] Fixtures cover: unavailable per-file patch, aggregate rejection, and the over-limit boundary
