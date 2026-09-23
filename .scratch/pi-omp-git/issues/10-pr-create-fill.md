# 10: `pr_create` with `fill` (nested agent machinery)

**What to build:** PR creation works end to end: `github {op: "pr_create"}` with an explicit `title`, or with `fill: true` to have the title and body generated from the change (mutually exclusive — `fill` plus a title or explicit body is invalid; omitted `head` uses the current branch). This ticket lands the **nested agent machinery** that later tickets reuse: a headless model session created through the SDK with no built-in tools, a narrow allowlist, a temporary session directory (never in the user's session list), and the current session's model unless overridden — plus the scripted-response test seam at that boundary. Bodies are passed through a temporary body file (explicitly empty bodies stay noninteractive) so `gh` never opens an editor. After creation the PR URL is parsed, a best-effort refresh produces a rich summary, and a refresh failure never turns a created PR into an error.

**Blocked by:** 08 (`github` dispatcher with `repo_view` and `file_read`).

**Status:** ready-for-agent

- [ ] `pr_create` with a title creates the PR; `fill: true` generates title and body from the change via the nested agent session
- [ ] `fill` plus a title or explicit body is rejected as invalid
- [ ] A nonempty body is supplied via a temporary body file; an explicitly empty body uses the noninteractive form — `gh` never opens an editor
- [ ] Nested agent sessions run with a narrow tool allowlist, a temporary session directory, and never appear in the user's session list
- [ ] Post-create: the returned PR URL is parsed, a best-effort refresh produces a rich summary, and refresh failure does not error the operation
- [ ] The scripted nested-agent response seam drives deterministic tests for `fill`
