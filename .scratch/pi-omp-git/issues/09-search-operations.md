# 09: Five search operations

**What to build:** All five searches work through the dispatcher: `search_issues`, `search_prs`, `search_code`, `search_commits`, `search_repos`. Results render agent-useful fields (not raw JSON) and always include canonical GitHub URLs. When no repository is given, issue/PR/code/commit searches default to the current repository unless the query already declares a broad scope; `search_repos` ignores the repository parameter. Date filters support relative units (`3m`, `12h`, `7d`, `2w`, `3mo`, `1y`) and absolute dates, with `created`/`updated` field selection (commits always use committer-date; code search rejects date filters). Limits default to 10, cap at 50, reject non-finite and non-positive values, floor non-integers, and clamp over-max.

**Blocked by:** 08 (`github` dispatcher with `repo_view` and `file_read`).

**Status:** ready-for-agent

- [ ] All five operations return agent-useful renderings with canonical URLs
- [ ] Default current-repo scoping applies when the query lacks an explicit scope qualifier; `search_repos` ignores `repo`
- [ ] Relative and absolute date filters work; `since` is a lower bound, `until` an upper bound; the `created`/`updated` mapping is correct per resource type
- [ ] Code search rejects `since`/`until`; commit search always uses committer-date
- [ ] Limit handling: default 10, max 50, non-finite and ≤0 rejected, non-integers floored, over-max clamped
- [ ] Search queries reach the API unaltered (no CLI layer rewriting query semantics)
