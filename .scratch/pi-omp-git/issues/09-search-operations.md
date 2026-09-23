# 09: Five search operations

**What to build:** All five searches work through the dispatcher: `search_issues`, `search_prs`, `search_code`, `search_commits`, `search_repos`. Results render agent-useful fields (not raw JSON) and always include canonical GitHub URLs. When no repository is given, issue/PR/code/commit searches default to the current repository unless the query already declares a broad scope; `search_repos` ignores the repository parameter. Date filters support relative units (`3m`, `12h`, `7d`, `2w`, `3mo`, `1y`) and absolute dates, with `created`/`updated` field selection (commits always use committer-date; code search rejects date filters). Limits default to 10, cap at 50, reject non-finite and non-positive values, floor non-integers, and clamp over-max.

**Blocked by:** 08 (`github` dispatcher with `repo_view` and `file_read`).

**Status:** ready-for-human

- [x] All five operations return agent-useful renderings with canonical URLs
- [x] Default current-repo scoping applies when the query lacks an explicit scope qualifier; `search_repos` ignores `repo`
- [x] Relative and absolute date filters work; `since` is a lower bound, `until` an upper bound; the `created`/`updated` mapping is correct per resource type
- [x] Code search rejects `since`/`until`; commit search always uses committer-date
- [x] Limit handling: default 10, max 50, non-finite and ≤0 rejected, non-integers floored, over-max clamped
- [x] Search queries reach the API unaltered (no CLI layer rewriting query semantics)

## Comments

- Searches hit the GitHub REST search endpoints through `gh api` (`search/issues`, `search/code`, `search/commits`, `search/repositories`) with the query URL-encoded into a single `q` parameter plus `per_page` — GitHub query syntax reaches the API unaltered, with no CLI layer rewriting semantics (§34). `search_prs` shares the issues endpoint behind an `is:pr` qualifier; `search_issues` appends `is:issue`.
- Default scoping resolves the current checkout locally (host included, for Enterprise) and appends `repo:owner/repo` unless the query already carries `repo:`/`org:`/`user:`/`owner:`; explicit `repo` parameters always append; resolution failure proceeds globally; `search_repos` never resolves or scopes (§36).
- Date grammar (§37): relative units `m`/`h`/`d`/`w`/`mo`/`y` become ISO-8601 instants at invocation time; `YYYY-MM-DD` and ISO datetimes pass through unaltered; unparseable values are rejected with the accepted grammar spelled out. `since` → `field:>=`, `until` → `field:<=`; `created`/`updated` map per resource (repositories' `updated` → `pushed:`, commits always `committer-date:`), and code search rejects both bounds before any I/O (§38).
- Limits (§35): default 10, max 50; non-finite, ≤0, and non-numeric values rejected; non-integers floored; over-max clamped.
- Renderings (§39) are numbered block lists with canonical `html_url` per entry: issues/PRs (number, title, state, repository, author, labels, created/updated), code (path, repository, short SHA, `<em>`-stripped text-match fragment via the text-match Accept header, URL), commits (short SHA, first message line, repository, author, committer date, URL), repositories (name, description, language, stars, forks, open issues, visibility, archived/fork, updated, URL). Every result carries the effective final query and totals in tool `details`.
- Failures classify through the stable taxonomy: auth → `AuthenticationError`, rate limit → `GithubApiError`, query validation → clear dispatcher-level message with sanitized stderr; malformed JSON → the friendly invalid-JSON error.
- Coverage: date/limit/broad-scope helper units, per-resource date mapping, scoping (omitted/broad-scope/global-fallback/explicit/Enterprise/`search_repos`), encoded single-`q` requests, per-resource renderings, empty results, limit policy through the tool, and the failure taxonomy.
- Verification: `npm test` (161 passing), `npm run typecheck` clean, `./node_modules/.bin/biome check .` clean.