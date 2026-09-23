# 07: Listing resources with filters

**What to build:** Browsing works: `read issue://` and `read pr://` (bare, or repository-scoped) list issues and PRs with `state`, `limit`, `author`, and `label` filters. Issue states are open/closed/all; PR states are open/closed/merged/all. Defaults are `state=open` and `limit=30`, values beyond 100 are clamped rather than erroring, and listings are fetched live rather than cached so browsing always reflects current state.

**Blocked by:** 04 (`pr://` rendering with reviews and comment suppression).

**Status:** ready-for-agent

- [ ] Bare and repository-scoped `issue://` and `pr://` listings honor `state`, `limit`, `author`, and `label`
- [ ] Defaults are `state=open`, `limit=30`; values above 100 are clamped
- [ ] PR listings support the `merged` state
- [ ] Listings are live-fetched — no cache rows are written or read for them
- [ ] Host-qualified listings work for Enterprise repositories
