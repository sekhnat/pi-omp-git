# 23: Changelog integration and `--push`

**What to build:** The commit pipeline completes with two integrations. Changelog: unless `--no-changelog`, the pipeline identifies the project's changelog and proposes a corresponding entry, committed as part of an appropriate commit — never a hidden unrelated mutation; a missing changelog is not an error; the entry respects the configured changelog diff budget. Push: `--push` pushes only after commit execution succeeds — PR branches created by checkout route through the PR push path (metadata, PR head ref), ordinary branches use the configured upstream; push rejections surface as errors and are never converted to force pushes; a clean tree with an explicit `--push` still pushes already-created local commits or clearly reports why no push occurred.

**Blocked by:** 22 (Split execution with conservation), 13 (`pr_push` with last-checkout resolution).

**Status:** ready-for-human

- [x] Changelog entries are proposed and committed within an appropriate commit; `--no-changelog` disables; missing changelog is not an error
- [x] `--push` never pushes before commits succeed
- [x] PR branches route through the PR push path (metadata, head ref, force-with-lease semantics); ordinary branches use upstream configuration
- [x] Push rejection surfaces as an error; never converted to a force push
- [x] Clean tree + explicit `--push`: existing local commits are pushed, or the reason no push occurred is clearly reported

## Comments

**Implemented**: unless `--no-changelog` (or the changelog config is
disabled), the pipeline identifies the project changelog
(CHANGELOG.md/CHANGELOG/changelog.md/HISTORY.md) and commits a
deterministic entry under `## Unreleased` as part of the first commit —
bounded by commit.changelogMaxDiffChars; a missing changelog is not an
error. `--push` pushes only after commit execution succeeds (and never
in dry-run): PR branches carrying pr_checkout metadata route through
the PR push path (metadata, PR head ref, --force-with-lease
availability), ordinary branches push to the configured upstream;
rejections surface as errors and are never converted to force pushes;
a clean tree with an explicit --push pushes already-created local
commits or clearly reports why no push occurred.
