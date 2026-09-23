# 02: `read` override with `issue://` single-resource rendering

**What to build:** `read issue://123` renders a complete GitHub issue — number, title, state and reason, author, created/updated, labels, URL, body, and comments — through the normal `read` tool, in the current repository, an explicit `owner/repo`, or a host-qualified form. Everything that is not a virtual GitHub URI delegates to Pi's native read with zero behavior change. Invalid URIs (traversal segments, non-positive numbers, bad percent-encoding, unexpected suffixes) fail with clear errors. Reads run live against the runner from ticket 01; caching comes later. This is the first read-only resource.

**Blocked by:** 01 (package skeleton, process runner, and dependency gating).

**Status:** ready-for-agent

- [ ] `read issue://123`, `issue://owner/repo/123`, and host-qualified forms render the full issue representation
- [ ] Repository context resolves from the current GitHub checkout when omitted; a missing context yields the friendly repository-context error
- [ ] Non-virtual paths delegate to the native read tool with identical behavior (spot-check pagination, truncation, and error shapes)
- [ ] URI validation rejects traversal segments, empty segments, non-positive numbers, invalid percent-encoding, and unexpected suffixes
- [ ] An older `gh` lacking a JSON field (e.g. state reason) triggers a retry with the field omitted rather than failing
- [ ] Tests drive the reads through the scripted `gh` runner fixtures
