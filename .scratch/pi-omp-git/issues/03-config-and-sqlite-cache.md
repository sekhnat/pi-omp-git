# 03: Configuration layering and the SQLite cache

**What to build:** Repeated `read issue://123` calls are served from a SQLite cache so only one `gh` invocation happens while the row is fresh. The cache honors the soft TTL (serve cached), the middle band (synchronously refresh, fall back to stale-with-warning), and the hard TTL (evict and refetch). Rows are scoped by a credential fingerprint (a digest, never the token), host, repository, kind, number, and comments mode — private content never crosses identities. A corrupt or unavailable database degrades to uncached operation. Configuration lands here too: a user file and a project file (read only after project trust), layered over defaults, covering cache TTLs and the database path, with environment overrides including the OMP migration aliases.

**Blocked by:** 02 (`read` override with `issue://` single-resource rendering).

**Status:** ready-for-agent

- [ ] A fresh cache row is served without a second `gh` invocation; soft-expired rows refresh synchronously and serve stale with a visible warning when refresh fails; hard-expired rows are evicted and refetched
- [ ] Two credential identities on the same machine never see each other's cached content; different Enterprise hosts never share rows
- [ ] Corrupt database: GitHub still works uncached — the extension does not crash
- [ ] Cache unavailability (probe failure, disabled) degrades to live reads without errors
- [ ] Configuration: user and trust-gated project files layer over defaults; TTLs and database path are configurable; environment overrides (including the OMP compatibility aliases) work
- [ ] Cache directory and database use restrictive permissions with WAL journaling; the built-in `node:sqlite` module is used (no native dependency)
