# 10: `pr_create` with `fill` (nested agent machinery)

**What to build:** PR creation works end to end: `github {op: "pr_create"}` with an explicit `title`, or with `fill: true` to have the title and body generated from the change (mutually exclusive — `fill` plus a title or explicit body is invalid; omitted `head` uses the current branch). This ticket lands the **nested agent machinery** that later tickets reuse: a headless model session created through the SDK with no built-in tools, a narrow allowlist, a temporary session directory (never in the user's session list), and the current session's model unless overridden — plus the scripted-response test seam at that boundary. Bodies are passed through a temporary body file (explicitly empty bodies stay noninteractive) so `gh` never opens an editor. After creation the PR URL is parsed, a best-effort refresh produces a rich summary, and a refresh failure never turns a created PR into an error.

**Blocked by:** 08 (`github` dispatcher with `repo_view` and `file_read`).

**Status:** ready-for-human

- [x] `pr_create` with a title creates the PR; `fill: true` generates title and body from the change via the nested agent session
- [x] `fill` plus a title or explicit body is rejected as invalid
- [x] A nonempty body is supplied via a temporary body file; an explicitly empty body uses the noninteractive form — `gh` never opens an editor
- [x] Nested agent sessions run with a narrow tool allowlist, a temporary session directory, and never appear in the user's session list
- [x] Post-create: the returned PR URL is parsed, a best-effort refresh produces a rich summary, and refresh failure does not error the operation
- [x] The scripted nested-agent response seam drives deterministic tests for `fill`

## Comments

- Nested agent machinery (`src/github/nested-agent.ts`, §75/ADR 0004): sessions are created through `createAgentSession` with `noTools: "all"`, a narrow built-in allowlist option, optional custom tools, the parent session's model passed from the tool's `ctx.model`, and in-memory session storage — a temporary session directory by effect, so nothing is written to the user's session directory and the run can never appear in the session list. The parent tool's abort signal aborts the nested run; sessions are always disposed. The factory is injectable — the scripted-response seam used by every test that exercises `fill`.
- `pr_create` (§22): explicit `title` or `fill: true` required, mutually exclusive with each other and with an explicit body; `reviewer[]`/`assignee[]`/`label[]` repeat through their flags; explicit `repo` routes `-R owner/repo` + `GH_HOST`; omitted repo/head let gh resolve the checkout. Nonempty bodies travel through `--body-file` (a temporary file, removed after the run); an explicitly empty or omitted body uses `--body ""` — `gh` never opens an editor.
- `fill` gathers branch context locally (head branch, upstream default from `origin/HEAD`, merge-base, the branch's commit log and diff stat), prompts the nested agent (narrow read-only allowlist: read/grep/find/ls), and parses the response as title (first nonempty line) plus body. Undeterminable branch fails the fill; context enrichment only degrades the prompt.
- Post-create: the canonical PR URL is parsed from gh's stdout (number plus host/owner/repo identity), a best-effort `gh pr view` refresh renders the rich §11 summary, and a refresh failure degrades to the basic "Created pull request" summary without failing the operation. Creation failures classify through the stable taxonomy (auth, rate limit, sanitized stderr).
- Coverage: §22 validation rules, explicit-title creation with body-file content checks, empty/omitted body forms, base/head/draft/repeated flag pass-through, Enterprise `GH_HOST`, refresh-failure survival, failure taxonomy, the nested-seam contract (no built-in tools, allowlist, model inheritance, in-memory storage, disposal), fill context/prompt/response parsing, and URL parsing.
- Verification: `npm test` (176 passing), `npm run typecheck` clean, `./node_modules/.bin/biome check .` clean.