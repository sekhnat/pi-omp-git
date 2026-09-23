# 08: `github` dispatcher with `repo_view` and `file_read`

**What to build:** The `github` model tool exists and its first two operations work. `repo_view` returns owner/name, description, canonical URL, default and requested branch, visibility, viewer permission, language, stars, forks, archived and fork status, last update, homepage, and topics — resolving the repository from the current checkout when omitted. `file_read` reads files stored in GitHub repositories: repository-relative path (leading slash rejected, segments URL-encoded), default branch when omitted, text decoded directly, images as image content, other binaries as metadata plus the GitHub source URL. The dispatcher validates its operation enum and returns clear errors for unknown operations. Prompt guidance is appended through the system-prompt build hook so the agent prefers these surfaces over curl/wget and scraping.

**Blocked by:** 02 (`read` override with `issue://` single-resource rendering).

**Status:** ready-for-human

- [x] `github {op: "repo_view"}` returns the full metadata set; omitted `repo` resolves via `gh`
- [x] `github {op: "file_read"}` returns decoded text for text files, image content for recognized images, and metadata plus source URL for other binaries
- [x] `file_read` rejects a missing path and a leading slash; path segments are individually URL-encoded
- [x] Unknown operations and malformed parameters produce clear dispatcher errors
- [x] Error taxonomy classes exist for GitHub unavailability, authentication, repository resolution, and API errors — tool-facing messages omit stack traces
- [x] Tool guidelines appear in the system prompt via the build hook (resources, diff URIs, file_read over curl, searches, checkout/push, run_watch, absolute worktree paths)

## Comments

- The `github` dispatcher registers one tool whose TypeBox schema carries the full §18 operation enum; unimplemented operations return a clear "not available in this build" error, and the schema literal list is compile-time-checked against the runtime enum tuple so the two cannot drift.
- `repo_view` runs `gh repo view [owner/repo] --json <15 fields>` — an omitted repo relies on gh's own checkout resolution, host-qualified identifiers route through `GH_HOST`, an older `gh` that rejects `repositoryTopics` triggers the legacy-field retry, and the renderer covers every §20 metadata line plus the requested branch.
- `file_read` calls the contents API with per-segment URL-encoded paths and `?ref=`; base64 content decodes to bytes, so text decodes as UTF-8, recognized images (png/jpg/gif/webp) return image content blocks, NUL-byte content degrades to metadata plus the GitHub source URL (submodules likewise), and the 1 MiB contents-API limit falls back to the raw media type for text while oversized images/binaries stay metadata-only (the runner's string transport is text-safe only).
- Added `GithubApiError` to complete the §90 GitHub taxonomy (unavailability/authentication/repo-resolution map to the existing dependency/auth/no-context classes); every dispatcher throw is a friendly message, never a stack trace.
- §59 guidelines append through `before_agent_start` → `systemPromptOptions.promptGuidelines`, never a rewritten prompt.
- Coverage: dispatcher validation, repo_view metadata/legacy/host/omitted-repo, file_read text/image/binary/encoding/branch/checkout-resolution/Enterprise/too-large/directory/auth/rate-limit surfaces, and the prompt-hook wiring test against the extension factory.
- Verification: `npm test` (140 passing), `npm run typecheck` clean, `./node_modules/.bin/biome check .` clean.