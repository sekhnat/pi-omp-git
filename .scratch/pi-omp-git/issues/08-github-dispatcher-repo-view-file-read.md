# 08: `github` dispatcher with `repo_view` and `file_read`

**What to build:** The `github` model tool exists and its first two operations work. `repo_view` returns owner/name, description, canonical URL, default and requested branch, visibility, viewer permission, language, stars, forks, archived and fork status, last update, homepage, and topics — resolving the repository from the current checkout when omitted. `file_read` reads files stored in GitHub repositories: repository-relative path (leading slash rejected, segments URL-encoded), default branch when omitted, text decoded directly, images as image content, other binaries as metadata plus the GitHub source URL. The dispatcher validates its operation enum and returns clear errors for unknown operations. Prompt guidance is appended through the system-prompt build hook so the agent prefers these surfaces over curl/wget and scraping.

**Blocked by:** 02 (`read` override with `issue://` single-resource rendering).

**Status:** ready-for-agent

- [ ] `github {op: "repo_view"}` returns the full metadata set; omitted `repo` resolves via `gh`
- [ ] `github {op: "file_read"}` returns decoded text for text files, image content for recognized images, and metadata plus source URL for other binaries
- [ ] `file_read` rejects a missing path and a leading slash; path segments are individually URL-encoded
- [ ] Unknown operations and malformed parameters produce clear dispatcher errors
- [ ] Error taxonomy classes exist for GitHub unavailability, authentication, repository resolution, and API errors — tool-facing messages omit stack traces
- [ ] Tool guidelines appear in the system prompt via the build hook (resources, diff URIs, file_read over curl, searches, checkout/push, run_watch, absolute worktree paths)
