# 07: Listing resources with filters

**What to build:** Browsing works: `read issue://` and `read pr://` (bare, or repository-scoped) list issues and PRs with `state`, `limit`, `author`, and `label` filters. Issue states are open/closed/all; PR states are open/closed/merged/all. Defaults are `state=open` and `limit=30`, values beyond 100 are clamped rather than erroring, and listings are fetched live rather than cached so browsing always reflects current state.

**Blocked by:** 04 (`pr://` rendering with reviews and comment suppression).

**Status:** ready-for-human

- [x] Bare and repository-scoped `issue://` and `pr://` listings honor `state`, `limit`, `author`, and `label`
- [x] Defaults are `state=open`, `limit=30`; values above 100 are clamped
- [x] PR listings support the `merged` state
- [x] Listings are live-fetched without reading or writing cache rows
- [x] Host-qualified listings work for Enterprise repositories

## Comments

- Listing URIs now parse and validate list-only filters, apply defaults and clamp large limits. The router fetches through `gh issue list` / `gh pr list`, resolves repository identity, and passes Enterprise hosts via `GH_HOST`. Results render as concise Markdown and bypass the resource cache.
- Added coverage for bare/repository-scoped and Enterprise listings, all filters, merged PRs, clamping, and live updates across repeated reads.
- Inline review against `1fc6aa1`: no Spec findings. Standards has one low-priority Duplicated Code judgement call: the listing failure mapper repeats common authentication/repository-context handling from the single-resource fetchers.
- Verification: `npm test` (106 passing), `npm run typecheck` clean, `./node_modules/.bin/biome check .` clean.
