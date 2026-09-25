# pi-omp-git

Git and GitHub workflows for [Pi](https://pi.dev/), packaged as a Pi extension with an optional companion CLI. The extension adds an interactive Git browser, an agent-assisted commit command, GitHub issue/PR resources through `read`, and a single `github` tool for repository inspection, search, pull requests, and GitHub Actions.

> **At a glance:** Git operations work without GitHub CLI authentication; GitHub operations require an installed, authenticated `gh`. The `/git` screen requires Pi's interactive terminal UI. The `github` tool is model-callable, **not** a `/github` slash command.

## Requirements and installation

- Node.js **22.19+** and [Pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`). This package targets the `@earendil-works` Pi distribution.
- `git` on `PATH` for local Git operations, commit workflows, checkout/push, and local repository detection.
- [GitHub CLI (`gh`)](https://cli.github.com/) on `PATH`, with `gh auth login` completed (`gh auth status` should succeed), for GitHub reads and operations. Enterprise hosts can use `GH_HOST` and the corresponding `gh` authentication.
- A configured Pi model with working credentials for agent-assisted features such as `/commit`, AI staging, generated commit messages, and `pr_create` with `fill: true`. Ordinary Git browsing and GitHub CLI-backed reads do not require a model call from the extension itself.

To load this checkout as a Pi package (from its parent directory):

```sh
cd /path/to/parent/pi-omp-git
npm ci
cd ..
pi install ./pi-omp-git
cd /path/to/your-project
pi
```

For one Pi invocation without saving a package declaration:

```sh
pi -e /absolute/path/to/pi-omp-git
```

The package manifest points Pi at `src/index.ts`. If you are working from this repository rather than an installed package, first install its dependencies with `npm ci`. Pi's package installation and the standalone executable are distinct: **do not assume `pi install` adds `pi-omp-git` to your shell's `PATH`**. See [Companion CLI](#companion-cli) for running it from the checkout.

In Pi, try `/omp-git-doctor` to report whether `git` and `gh` are available/authenticated. Probes and the GitHub cache open lazily, not when the extension loads.

## Quick start

From a Git checkout with a GitHub remote:

1. Run `/git` to inspect staged, unstaged, and conflicting files. Use `s` to stage, `u` to unstage, `d` to discard (with confirmation), and `q` to close the screen.
2. Run `/commit --dry-run` to preview an agent-generated commit plan without staging, committing, or pushing. Then run `/commit` to create commits; `--push` is opt-in.
3. Ask Pi to read `issue://42`, `pr://42`, or `pr://42/diff` using its `read` tool. Use `issue://owner/repo/42` outside the current checkout.
4. Ask Pi to search issues, inspect a repository file, or check out a PR through the `github` tool. After a PR checkout, use the returned **absolute `worktreePath`** to read/edit files; the original checkout remains where it is.

For example, ask Pi: “Use `github` to search open bug issues in this repository,” or “Read `pr://42/diff`, then check out PR 42 into its managed worktree.” JSON examples below describe **tool arguments** the agent sends; they are not shell commands.

## Pi commands and Git TUI

| Command | Behavior |
|---|---|
| `/git` | Interactive status and side-by-side diff view; stage, unstage, discard, commit, and optional AI staging. Requires Pi's TUI mode. |
| `/git <revision>` | Inspect the files changed by a Git revision in a **read-only** TUI. |
| `/commit [options]` | Plan and execute one or more agent-assisted Git commits. |
| `/omp-git-doctor` | Display `git` and `gh` availability/authentication status. |
| `/omp-git-doctor` | Display environment diagnostics: `git`/`gh` versions, availability, authentication status, configuration sources, and path checks. |
`/git` is unavailable in Pi's print, JSON, or RPC modes. The TUI shows staged/unstaged/conflict sections and a side-by-side diff; binary and oversized files have limited previews. The same TUI is available from the companion CLI.

| Key | In `/git` |
|---|---|
| `↑` / `↓` or `k` / `j` | Select a file, or a hunk while in hunk mode. |
| `Tab` | Switch staged/unstaged/conflict area. |
| `h` | Toggle file/hunk mode for textual diffs. |
| `s` / `u` | Stage or unstage selected file/hunk. |
| `d` | Discard selected change; destructive operations request `y`/`n` confirmation. |
| `c` | Open commit-message composer. `Enter` commits, `Esc` closes, `g` generates a message, `a` toggles amend. |
| `a` | Open AI staging prompt; submit instructions with `Enter`, then approve or reject its proposed staging plan with `y`/`n`. |
| `r` | Refresh Git status/diff. |
| `q` or `Esc` | Close the screen (or dismiss the active prompt). |

In revision mode, browsing/diff navigation still works, but working-tree mutations, committing, and AI staging are disabled.

### Agent-assisted `/commit`

```text
/commit --dry-run
/commit
/commit --all
/commit --push
/commit --no-changelog
/commit --model provider/model-id
/commit --context "release notes for 0.1.0"
```

Supported flags: `--dry-run`, `--all`, `--push`, `--no-changelog`, `--context <text>` (or `--context=<text>`), and `--model <model>` (or `--model=<model>`). Both hosts share one strict parser: unknown flags, missing or invalid values, duplicate `--context`/`--model`, and bare positional arguments are errors — they are not silently ignored. Quoted multi-word contexts work (`--context "release notes"`); after `--`, the remaining words are treated as context. `--model` matches a model ID or `provider/id` in the current Pi model registry; otherwise it uses the session model.

The pipeline examines the Git index, working tree, and recent commit subjects, proposes a plan, optionally updates an existing changelog, then executes the commits. If changes are already staged, it commits the planned staged set; **if nothing is staged but the tree is dirty, a non-dry-run invocation stages all changes (`git add -A .`) in compatibility mode**. Review the plan and your Git status before executing. Unresolved conflicts abort. A clean tree reports that no commit was created. A dry run does not stage, commit, edit the changelog, or push. `--push` pushes only after commits succeed (or can report/push existing commits on a clean tree); it is never implied by `/commit`.
The pipeline examines the Git index, working tree, and recent commit subjects, proposes a plan, optionally updates an existing changelog, then executes the commits. **Commits operate on the staged set by default.** If nothing is staged but the tree is dirty, the command stops with an actionable no-staged-changes result — it stages, commits, and pushes nothing, even with `--push`. Pass `--all` to explicitly stage tracked modifications, deletions, and untracked files for this commit: the plan is prepared against a temporary copy of the index, and the real index is updated only after a valid proposal is approved. A dry run never stages, commits, edits the changelog, or push. Review the plan and your Git status before executing. Unresolved conflicts abort. A clean tree reports that no commit was created. `--push` pushes only after commits succeed (and can push existing commits on a clean tree); it is never implied by `/commit`.
The agent may suggest a split plan. `commit.splitPolicy` controls handling: `confirm` (default) asks for interactive approval when multiple commits are proposed; `auto` executes the validated split; `never` collapses it to one commit. Without an interactive confirmation path, a split plan under `confirm` fails explicitly rather than silently proceeding. Changelog integration applies only when a changelog is found and enabled.

## Read GitHub resources through `read`

The extension overrides Pi's `read` tool **only** for `issue://` and `pr://` paths. Ordinary local files and images still use Pi's native `read`. Bare forms infer the GitHub repository from the checkout's Git remote; use `owner/repo` to be explicit. `host/owner/repo` forms are accepted for issue/PR reads and listings (the host defaults to `GH_HOST`, then `github.com`).

| Path passed as `read.path` | Result |
|---|---|
| `issue://`, `pr://` | List open issues or PRs in the current repository. |
| `issue://owner/repo`, `pr://owner/repo` | List items in an explicit repository. `host/owner/repo` also works. |
| `issue://42`, `pr://42` | Read one item, including comments by default. |
| `issue://owner/repo/42`, `pr://owner/repo/42` | Read one explicit-repository item. `host/owner/repo/42` also works. |
| `pr://42/diff` | Numbered index of files changed by a PR. |
| `pr://42/diff/1` | Patch for the **1-based** file index 1. |
| `pr://42/diff/all` | Full unified PR diff (potentially large). |

PR diff paths also accept `pr://owner/repo/42/diff[/1|/all]`; **host-qualified diff paths are not supported**. Issue paths do not support `/diff`. Item numbers and diff file indices are positive integers.

List query parameters are `state` (`open`, `closed`, `all`; additionally `merged` for PRs), `limit` (default 30, maximum 100), `author`, and `label`, e.g. `pr://owner/repo?state=merged&limit=20`. Single issue/PR reads accept `?comments=0` (or `false`) to omit comments; `1`/`true` includes them. Do not put comment filters on lists or diffs.

Virtual reads return rendered Markdown with the normal `read` `offset` (1-based line number) and `limit` controls. Long responses are truncated with a next-offset notice; use `read` again with that offset. Single issue/PR views and PR diffs use the local SQLite cache when eligible; **listings are always fetched live**. See [Cache and stored data](#cache-and-stored-data).

## `github` tool reference

`github` is **one model-callable tool** with an `op` field. Ask Pi to use it, or supply the corresponding arguments when integrating with Pi tooling. `repo` generally accepts `owner/repo` or `host/owner/repo`; where omitted, most operations use the current checkout. Common fields are operation-specific, not globally required.

### Repository and files

| `op` | Key fields | Result and notes |
|---|---|---|
| `repo_view` | `repo?`, `branch?` | Repository description, default branch, permissions/visibility, language, stars, forks, topics, etc. `branch` is shown as the requested ref; it does **not** switch the checked-out branch. |
| `file_read` | `path` (required); `repo?`, `branch?` | Read a repository-relative file from the requested ref (default: repository default branch). Text is decoded; supported PNG/JPEG/GIF/WebP images return image content; other binaries return metadata and a source URL. Large files may fall back to raw text or metadata. No leading `/`, `.`/`..`, or empty path segments. |

```json
{"op":"repo_view","repo":"owner/repo"}
```

```json
{"op":"file_read","repo":"owner/repo","branch":"main","path":"src/index.ts"}
```

### Pull requests

| `op` | Key fields | Result and notes |
|---|---|---|
| `pr_create` | `title` **or** `fill: true`; optional `body`, `repo`, `base`, `head`, `draft`, `reviewer[]`, `assignee[]`, `label[]` | Create a PR noninteractively. `fill` generates a title and body with a nested agent and cannot be combined with explicit `title` or `body`. An empty `body` is valid with explicit `title`. |
| `pr_checkout` | `pr` (required string **or array of strings**), `repo?`, `force?` | Prepare a `pr-N` branch in a managed worktree, without changing the current checkout. Accepts PR number **as a string**, URL, or branch-like identifier. Returns `worktreePath`, `checkouts[]`, and, for batches, possible `failures[]`. Correct-SHA checkouts can be reused; `force: true` permits resetting a conflicting PR branch, so use deliberately. |
| `pr_push` | `pr?` (single string), `branch?`, `forceWithLease?` | Push a prepared PR branch to its head remote; resolves an explicit PR/branch first, otherwise the session's last checkout, otherwise current-branch PR metadata. No implicit force push: `forceWithLease: true` is the only override. |

```json
{"op":"pr_create","title":"Describe the change","body":"Why this change matters","base":"main","draft":true}
```

```json
{"op":"pr_create","fill":true,"reviewer":["teammate"]}
```

```json
{"op":"pr_checkout","pr":["42","43"]}
```

```json
{"op":"pr_push","pr":"42"}
```

A batch checkout can partly succeed: inspect both `checkouts[]` and `failures[]`; if all fail, the operation fails. After checkout, **read/edit files via the absolute `worktreePath`** returned to Pi. `pr_push` requires checkout metadata (including the PR head ref), not just a similarly named branch. A successful push invalidates cached PR/diff entries. A session's last checkout is recorded in Pi's transcript and survives resuming that session.

### Search

| `op` | Searches |
|---|---|
| `search_issues` | GitHub issues (`is:issue` added). |
| `search_prs` | GitHub pull requests (`is:pr` added). |
| `search_code` | Code (no `since`/`until` support). |
| `search_commits` | Commits (date bounds use committer date). |
| `search_repos` | Repositories globally (`repo` is ignored; `dateField: "updated"` filters push time). |

All search operations require nonempty `query` using GitHub search syntax. Optional `repo`, `since`, `until`, `dateField` (`created` or `updated`), and `limit` (default 10; maximum 50) refine results. Date bounds accept relative `3m`, `12h`, `7d`, `2w`, `3mo`, `1y`, an absolute `YYYY-MM-DD`, or ISO-8601. Code search rejects date bounds. Repository scope defaults to the current checkout for issues/PRs/code/commits unless your query already has `repo:`, `org:`, `user:`, or `owner:`; if no checkout repository resolves, the search can proceed globally. Explicit `repo` takes precedence. The original query is retained and scope/date qualifiers are appended; results include canonical URLs.

```json
{"op":"search_issues","query":"is:open label:bug in:title","since":"7d","limit":20}
```

```json
{"op":"search_code","repo":"owner/repo","query":"parseGithubUri"}
```

### GitHub Actions

`run_watch` watches a single Actions run (`run`: ID as a **string**, or a run URL) or all workflow runs for a commit (`commit` SHA or single `pr`; neither `run` nor `commit`/`pr` means the session's last PR checkout branch, then current `HEAD`). `run` cannot be combined with `commit` or `pr`. `repo` is optional; `tail` controls failed-job inline log lines (default 15, capped at 200). The tool streams progress, reports success/failure/no-runs, and saves full failed-job logs to the artifacts directory when possible. Commit mode waits up to 90 seconds for runs to appear; polling can be cancelled.

```json
{"op":"run_watch","run":"123456789","tail":30}
```

```json
{"op":"run_watch","pr":"42","repo":"owner/repo"}
```

## Companion CLI

The standalone entry point is `bin/pi-omp-git.mjs`. After installing this checkout's dependencies, run it with Node, or use `pi-omp-git` if you separately installed the npm package in a way that exposes its `bin` entry:

```sh
node ./bin/pi-omp-git.mjs --help
node ./bin/pi-omp-git.mjs doctor
node ./bin/pi-omp-git.mjs git -C /path/to/repository
node ./bin/pi-omp-git.mjs git HEAD~1 -C /path/to/repository
node ./bin/pi-omp-git.mjs commit --dry-run -C /path/to/repository
node ./bin/pi-omp-git.mjs commit --all --push -C /path/to/repository
node ./bin/pi-omp-git.mjs commit --model provider/model-id --context "prepare release" -C /path/to/repository
```

Run these `node ./bin/...` examples from this repository's root. `git [revision] [-C <dir>]` requires a terminal with TTY input **and** output; revision mode is read-only. `doctor` prints local environment diagnostics (tool versions, Git/`gh` availability and authentication, configuration sources, and path writability) without a Pi session; credential material is redacted. `commit [--all] [--push] [--dry-run] [--no-changelog] [--context <text>] [--model <model>] [-C <dir>]` uses the same pipeline and shared strict argument parser as `/commit` but a standalone model registry; it does not inherit the current Pi session model. The companion command reads the **user** config only (`projectTrusted: false`). Its default `commit.splitPolicy` is `confirm`, so a multi-commit proposal needs `auto` or `never` in user config: the CLI has no interactive split-confirmation callback. Successful commits, dry runs, no-staged-changes guidance, and a definitive clean-tree result return exit code 0; failures return 1.
## Configuration

The extension reads JSON from `<agent dir>/pi-omp-git.json` and, after Pi trusts the project, `<project>/.pi/pi-omp-git.json`. Resolution order is **later layer wins per key**: built-in defaults ← user file ← trusted project file ← environment overrides. Only well-typed values are applied — an invalid or unknown key falls back to the value of the layer below it, and an unparseable file is ignored entirely. The project file is never read before Pi grants project trust. The standalone CLI resolves the user file only (it never reads project configuration). Configuration is resolved when used, so check a new command/operation after changing it.

Example **user** configuration (adjust to your workflow):

```json
{
  "github": {
    "cache": { "enabled": true, "softTtlSec": 300, "hardTtlSec": 604800 }
  },
  "worktree": { "root": "/absolute/path/to/managed-worktrees" },
  "commit": {
    "splitPolicy": "confirm",
    "analyzeFilesEnabled": true,
    "analyzeFilesMaxFiles": 8,
    "analyzeFilesMaxConcurrency": 4,
    "changelog": true,
    "changelogMaxDiffChars": 2000,
    "dryRunAnalyzeFiles": false
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `github.cache.enabled` | `true` | Enable eligible issue, PR, and PR-diff caching. |
| `github.cache.softTtlSec` / `hardTtlSec` | `300` / `604800` | Fresh/maximum cache ages in seconds; effective hard TTL is at least soft TTL. |
| `worktree.root` | `<agent dir>/worktrees` | Root for managed PR worktrees. |
| `commit.splitPolicy` | `confirm` | `confirm`, `auto`, or `never` for multi-commit proposals. |
| `commit.analyzeFilesEnabled` | `true` | Enable per-file agent analysis. |
| `commit.analyzeFilesMaxFiles` / `analyzeFilesMaxConcurrency` | `8` / `4` | Cap per-file analysis count/concurrency. |
| `commit.changelog` / `changelogMaxDiffChars` | `true` / `2000` | Integrate with a discovered changelog, with bounded diff context. |
| `commit.dryRunAnalyzeFiles` | `false` | Allow per-file agent analysis during dry runs (may cost model calls). |

`github.enabled: false` disables GitHub integration at both the registration and execution boundaries: the `github` tool is not advertised, tool calls and virtual `issue://`/`pr://` reads report `GitHub integration is disabled by configuration.`, model-facing guidance and shell-mutation observers are suppressed, and cache construction stays deferred. Git-only features (`/git`, `/commit` without `--push`) keep working. The gate is re-evaluated per operation, so config edits take effect without restarting the session.

| Environment variable | Effect |
|---|---|
| `PI_OMP_GITHUB_CACHE_DB` | Override SQLite database path (`OMP_GITHUB_CACHE_DB` is a fallback alias). Default: `<agent dir>/cache/pi-omp-git/github-cache.db`. |
| `PI_OMP_GIT_WORKTREE_DIR` | Override worktree root (`OMP_WORKTREE_DIR` is a fallback alias); takes precedence over JSON `worktree.root`. |
| `GH_HOST` | Default GitHub host when an explicit host is not supplied. |
| `GH_TOKEN`, `GITHUB_TOKEN`, enterprise token variables, `GH_CONFIG_DIR` | Credential/config material used to isolate cached content by credential fingerprint, alongside `gh` authentication. |

The package constructs its agent directory from the home directory (`~/.pi/agent`) rather than reading Pi's optional custom agent-directory setting. Log artifacts default to `~/.pi/agent/artifacts/pi-omp-git`.
The package resolves Pi-owned state under Pi's configured agent directory (honoring `PI_CODING_AGENT_DIR` where Pi supports it) rather than assuming `~/.pi/agent`. Log artifacts default to `<agent dir>/artifacts/pi-omp-git`, and the default cache and worktree roots live under the same directory.
### Cache and stored data

The GitHub cache uses Node's built-in SQLite implementation and opens lazily. Fresh cached issue/PR/diff views are served directly. After the soft TTL, issues and PRs refresh synchronously (showing a warning and stale content if refresh fails); diffs can serve a stale copy while refreshing in the background. Beyond the hard TTL the entry is fetched anew. Missing credential fingerprint, disabled caching, or cache/database failures fall back to uncached reads. Listings and search are live. `gh` mutations detected through Pi's shell hooks invalidate affected cache data **before** shell execution; confirmed `pr_push` invalidates that PR afterward. Mutation detection is heuristic, so external changes can remain cached until refresh/expiry.

Cache rows are scoped to repository, host, resource/comment mode, and a SHA-256 credential fingerprint; raw tokens are not stored as cache keys. The database and artifact paths are local to your machine; treat cached issue/PR text and saved job logs as potentially sensitive.

## Architecture and development

- `src/index.ts` registers the `read` override, `github` tool, slash commands, prompt guidelines, and shell-mutation observers. Checkout records are stored as Pi session entries.
- `src/github/resources/` parses/renders virtual reads; `src/github/dispatcher.ts` validates and routes tool operations; `src/github/operations/` implements the individual API-backed workflows; `src/github/cache/` stores eligible views.
- `src/git/` contains the Git runner/status/diff model, interactive TUI, staging/commit operations, and shared agent-assisted commit pipeline. `src/cli.ts` and `bin/pi-omp-git.mjs` host the standalone CLI.
- `src/shared/` handles layered configuration, subprocess execution, and errors. `test/` covers resource parsing, GitHub operations, TUI, commit workflows, and the companion binary with scripted seams.

From the repository root:

```sh
npm ci
npm run check
npm run smoke:pack
```

`npm run check` is the canonical gate: TypeScript typecheck, Biome lint/format validation, and the full Vitest suite in one command. `npm run smoke:pack` packs the package and installs the tarball into an isolated fixture, verifying the CLI entrypoint, Pi extension loading, and declared peers. The repository declares `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, and `typebox` as peer dependencies and requires Node.js 22.19+.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and the documentation map.
## Troubleshooting

| Symptom | What to check |
|---|---|
| GitHub calls report `gh` missing or unauthenticated | Install `gh`, run `gh auth login` / `gh auth status`, and restart the Pi session if an earlier availability probe was cached. Git-only features can still work. |
| Bare `issue://42`, `pr://42`, or `file_read` cannot determine a repository | Work from a Git checkout with a recognized GitHub remote, or pass `owner/repo` explicitly. |
| `/git` will not open | Use Pi's interactive TUI rather than print/JSON/RPC mode; ensure `git` is installed. The companion `git` command also needs an interactive TTY. |
| `pr_push` reports missing checkout metadata | Run `pr_checkout` first and use its prepared branch/worktree; a plain Git branch is not enough. |
| Standalone `commit` refuses a split plan | Set `commit.splitPolicy` to `auto` or `never` in **user** config, or use `/commit` in interactive Pi to confirm. |
| GitHub views appear outdated | Cached singles/diffs honor TTLs and detected shell mutations; listings are live. Check `github.cache` settings or disable caching when immediate freshness matters. |

## License

MIT — see [LICENSE](LICENSE).
