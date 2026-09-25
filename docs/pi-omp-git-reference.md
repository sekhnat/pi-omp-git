# pi-omp-git reference — section index

The original `pi-omp-git` development plan was written against a long-form
reference document with numbered sections (`§1`–`§110`). That narrative
document is not tracked in this repository; the section numbers survive in
source and test comments because they identify behavior precisely. This index
maps every section number cited in this checkout to the component that
implements it, so the citations resolve to real code.

Historical identifiers that also appear in comments (`ticket NN`, `Testing
Decisions seam N`, `divergence DN`) come from the same original planning log;
they are provenance labels, not pointers to tracked files.

| Sections | Component | Primary files |
|---|---|---|
| §4 | GitHub availability probes (memoized per process) | `src/github/availability.ts` |
| §7 | The `read` override for `issue://` and `pr://` URIs | `src/github/resources/router.ts` |
| §8–§10 (incl. §8.1, §9) | Virtual URI parsing and validation | `src/github/resources/parser.ts`, `test/uri-parser.test.ts` |
| §10, §12–§14 | Filtered live issue/PR listings | `test/pr-read.test.ts` |
| §11–§14 | PR virtual reads (single item, comments) | `src/github/resources/prs.ts` |
| §15–§17 | PR diff resources (`/diff`, `/diff/N`, `/diff/all`) | `src/github/resources/diffs.ts` |
| §18 | GitHub dispatcher and stable tool schema | `src/github/dispatcher.ts` |
| §§18–21 | Dispatch of repository/file operations | `test/github-dispatcher.test.ts` |
| §20 | `repo_view` operation | `src/github/operations/repo-view.ts` |
| §21 | `file_read` operation | `src/github/operations/file-read.ts` |
| §22 | `pr_create` operation | `src/github/operations/pr-create.ts`, `test/github-pr-create.test.ts` |
| §23–§28 | `pr_checkout` operation and managed worktrees | `src/github/operations/pr-checkout.ts`, `test/pr-checkout.test.ts` |
| §24, §29 | PR identifier parsing and batch forms | `src/github/pr-ref.ts`, `test/pr-checkout-batch.test.ts` |
| §30 | Companion CLI binary | `src/cli.ts` |
| §31 | Repository mutation lock (in-process serialization) | `src/git/mutation-lock.ts` |
| §32–§33 | `pr_push` operation | `src/github/operations/pr-push.ts`, `test/pr-push.test.ts` |
| §34–§39 | GitHub search operations | `src/github/operations/search.ts` |
| §40–§45 | `run_watch` Actions watching (run and commit modes) | `src/github/operations/run-watch.ts`, `test/run-watch.test.ts` |
| §46–§49 | Subprocess runner seams and parity limits | `src/shared/subprocess.ts`, `src/shared/limits.ts`, `src/github/runner.ts` |
| §50 | Repository identity resolution | `src/github/repo.ts` |
| §51–§56 | GitHub SQLite cache (store, facade, credential fingerprint) | `src/github/cache/db.ts`, `src/github/cache/cache.ts`, `src/github/cache/auth-key.ts` |
| §57, §58 | Cache invalidation via shell mutation hooks | `src/github/invalidation.ts`, `test/gh-mutation-invalidation.test.ts` |
| §59 | Model-facing prompt guidelines | `src/github/prompt-guidelines.ts` |
| §60–§67 | `/git` TUI, status/diff model, hunk operations, revision mode | `src/git/tui.ts`, `src/git/status-model.ts`, `src/git/diff.ts`, `src/git/model-ops.ts`, `src/git/revision.ts` |
| §68–§69, §99 | Headless status-model behavior and TUI model-layer requirements | `test/git-status-model.test.ts`, `test/git-tui.test.ts`, `test/git-model-ops.test.ts` |
| §70–§71 | AI staging for the `/git` TUI | `src/git/ai-stage.ts` |
| §72, §79–§80, §83–§85 | Commit composer and transactional execution | `src/git/commit-ops.ts`, `src/git/commit-execute.ts` |
| §73–§86 (incl. §73, §100) | Agentic `/commit` pipeline and its acceptance behavior | `src/git/commit-pipeline.ts`, `test/commit-pipeline.test.ts` |
| §75–§78 | Commit agent, nested agent sessions, plan structures | `src/git/commit-agent.ts`, `src/git/commit-plan.ts`, `src/github/nested-agent.ts` |
| §81 | Changelog integration | `src/git/commit-changelog.ts` |
| §86 | `--push` routing | `src/git/commit-push.ts` |
| §88 | Configuration layering (defaults ← user ← trusted project ← environment) | `src/shared/config.ts` |
| §90 | Error taxonomy and token echoing | `src/shared/errors.ts` |
| §95, §96, §98 | Acceptance references for `pr_checkout`, `pr_push`, `run_watch` | `test/pr-checkout.test.ts`, `test/pr-push.test.ts`, `test/run-watch.test.ts` |
| §110 | Last-checkout records in the Pi session | `src/github/last-checkout.ts` |

ADR citations point at `docs/adr/0004-shared-commit-hosts.md`.

Maintenance rule: when adding a new section citation to source comments, add a
row here (or cite an existing row). Keep the index to components that actually
exist in this repository.
