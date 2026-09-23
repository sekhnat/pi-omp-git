# 03: Configuration layering and the SQLite cache

**What to build:** Repeated `read issue://123` calls are served from a SQLite cache so only one `gh` invocation happens while the row is fresh. The cache honors the soft TTL (serve cached), the middle band (synchronously refresh, fall back to stale-with-warning), and the hard TTL (evict and refetch). Rows are scoped by a credential fingerprint (a digest, never the token), host, repository, kind, number, and comments mode — private content never crosses identities. A corrupt or unavailable database degrades to uncached operation. Configuration lands here too: a user file and a project file (read only after project trust), layered over defaults, covering cache TTLs and the database path, with environment overrides including the OMP migration aliases.

**Blocked by:** 02 (`read` override with `issue://` single-resource rendering).

**Status:** ready-for-human

- [x] A fresh cache row is served without a second `gh` invocation; soft-expired rows refresh synchronously and serve stale with a visible warning when refresh fails; hard-expired rows are evicted and refetched (test/issue-read.test.ts: fresh-row single gh call, soft-refresh synchronous refetch, stale-with-notice on refresh failure, hard-TTL evict + refetch)
- [x] Two credential identities on the same machine never see each other's cached content; different Enterprise hosts never share rows (CacheIdentity = SHA-256 credential fingerprint + host + owner + repo + kind + number + includeComments; rows isolated by fingerprint — cache/auth-key.ts digests tokens + hosts.yml, never persisting them)
- [x] Corrupt database: GitHub still works uncached — the extension does not crash (openCacheStore probes node:sqlite first and returns NullCacheStore on failure; every store op try/catches and degrades)
- [x] Cache unavailability (probe failure, disabled) degrades to live reads without errors (disabled cache / null credential fingerprint / degraded store all pass through uncached)
- [x] Configuration: user and trust-gated project files layer over defaults; TTLs and database path are configurable; environment overrides (including the OMP compatibility aliases) work (src/shared/config.ts: defaults < user < project-if-trusted < env; PI_OMP_GITHUB_CACHE_DB > OMP_GITHUB_CACHE_DB > <agentDir>/cache/pi-omp-git/github-cache.db)
- [x] Cache directory and database use restrictive permissions with WAL journaling; the built-in `node:sqlite` module is used (no native dependency) (db dir 0700, db/-wal/-shm 0600 best-effort POSIX; PRAGMA journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000)
