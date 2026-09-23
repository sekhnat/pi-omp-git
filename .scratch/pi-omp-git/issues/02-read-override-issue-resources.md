# 02: `read` override with `issue://` single-resource rendering

**What to build:** `read issue://123` renders a complete GitHub issue — number, title, state and reason, author, created/updated, labels, URL, body, and comments — through the normal `read` tool, in the current repository, an explicit `owner/repo`, or a host-qualified form. Everything that is not a virtual GitHub URI delegates to Pi's native read with zero behavior change. Invalid URIs (traversal segments, non-positive numbers, bad percent-encoding, unexpected suffixes) fail with clear errors. Reads run live against the runner from ticket 01; caching comes later. This is the first read-only resource.

**Blocked by:** 01 (package skeleton, process runner, and dependency gating).

**Status:** ready-for-human

- [x] `read issue://123`, `issue://owner/repo/123`, and host-qualified forms render the full issue representation
- [x] Repository context resolves from the current GitHub checkout when omitted; a missing context yields the friendly repository-context error
- [x] Non-virtual paths delegate to the native read tool with identical behavior (spot-check pagination, truncation, and error shapes)
- [x] URI validation rejects traversal segments, empty segments, non-positive numbers, invalid percent-encoding, and unexpected suffixes
- [x] An older `gh` lacking a JSON field (e.g. state reason) triggers a retry with the field omitted rather than failing
- [x] Tests drive the reads through the scripted `gh` runner fixtures

## Comments

- Implemented (ticket 02). URI grammar + validation in `src/github/resources/parser.ts` (§8/§9 — bare, repo-scoped, host-qualified, and the PR-diff/listing shapes parsed; single-issue rendering routed, PR/listing renderings arrive with tickets 04/05/07). Issue fetch + `stateReason` field-omission retry + error taxonomy mapping in `src/github/resources/issues.ts`; deterministic Markdown rendering and Pi-native pagination discipline (2000 lines / 50 KB, standard continuation notices, identical out-of-range errors) in `src/github/resources/render.ts` (built on Pi's exported `truncateHead`/`formatSize`); the `read` override + delegation in `src/github/resources/router.ts`; wiring in `src/index.ts` (registers a `read` tool replacing the built-in, delegating via Pi's built-in-tool-renderer pattern).
- Verification: `npm test` (63 passing — URI grammar matrix, render content, `-R`/`GH_HOST` scoping, comment suppression, minimized-comment exclusion, stateReason retry, delegation identity vs the native read, native-cap truncation + continuation notices, dependency gating, friendly errors), `npm run typecheck` clean, `biome check` clean. `pi -ne -e . --no-tools -p "…"` loads the package and completes a turn; `read` is registered.
- Note: extension commands are not dispatched in `--print` mode (TUI-only). Note: because two extensions claiming the same tool name is a load conflict in Pi (resource-loader `detectExtensionConflicts`), installing pi-omp-git alongside another extension that also overrides `read` requires filtering one via package resource filters — a Pi-level configuration concern, recorded here for the README (ticket 24 / docs).