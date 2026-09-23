# pi-omp-git

## OMP Git/GitHub parity layer for upstream Pi

**Status:** Implementation specification
**Target:** upstream `pi` coding agent
**Reference baseline:** current `can1357/oh-my-pi` behavior observed September 2026
**Package working name:** `pi-omp-git`
**Amendments:** reviewed against Pi 0.87.1 and OMP `b52e1f5` (see `EXPLORE.md`); decisions recorded in `docs/adr/` and `CONTEXT.md`. Key additions: divergence register (§108), authorization model (§109), post-checkout workflow (§110), worktree lifecycle (§111).

---

# 1. Objective

Implement an upstream Pi package that reproduces the Git and GitHub capabilities of Oh My Pi without requiring the user to run OMP.

The extension MUST reproduce the **observable behavior and workflows** rather than copy OMP internals unnecessarily.

The target consists of four major surfaces:

1. **GitHub virtual filesystem**

   * `issue://`
   * `pr://`
   * PR diff resources

2. **GitHub agent operations**

   * repository inspection
   * GitHub repository file reading
   * PR creation
   * isolated PR checkout
   * PR branch pushing
   * GitHub search
   * GitHub Actions monitoring

3. **Interactive Git UX**

   * OMP-style Git TUI
   * staged/unstaged navigation
   * per-file and per-hunk operations
   * AI staging
   * commit composition

4. **Agentic commit pipeline**

   * change analysis
   * conventional commit generation
   * optional split commits
   * changelog integration
   * dry-run
   * push

OMP currently uses `gh` as its GitHub transport, limits GitHub functionality to GitHub/GitHub Enterprise rather than providing a generic forge abstraction, and uses dedicated worktrees for PR checkout.

---

# 2. Compatibility goals

The implementation SHALL use RFC-style requirement terminology:

* **MUST** — required for parity.
* **SHOULD** — expected unless an upstream Pi limitation prevents it.
* **MAY** — enhancement that does not affect parity.

The package SHALL prioritize:

1. behavioral compatibility with OMP;
2. preservation of normal upstream Pi behavior;
3. non-destructive Git operations;
4. explicit repository identity;
5. deterministic error behavior;
6. compatibility with private GitHub repositories;
7. GitHub Enterprise compatibility.

It MUST NOT require a fork of Pi.
Where this specification is deliberately stronger than current OMP, the divergence register (§108) records the difference and the reason; “parity” means OMP behavior except where §108 says otherwise.

---

# 3. Scope boundary

## 3.1 Included

The parity release covers:

* `issue://` reads and listings;
* `pr://` reads and listings;
* `pr://.../diff` resources;
* comments, reviews, and review comments;
* GitHub cache behavior;
* repository viewing;
* GitHub repository file reading;
* issue search;
* PR search;
* code search;
* commit search;
* repository search;
* PR creation;
* PR checkout to dedicated worktrees;
* PR push;
* GitHub Actions run watching;
* GitHub Enterprise hosts;
* cache invalidation following GitHub mutations;
* OMP-style interactive Git UI;
* AI staging;
* agentic commit generation/splitting;
* optional changelog modification;
* optional pushing.

## 3.2 Explicit non-goals

The parity release MUST NOT silently expand the product into functionality OMP itself does not expose as a first-class operation.

In particular:

* GitLab support is not required.
* Bitbucket support is not required.
* Gitea/Forgejo support is not required.
* generic forge auto-detection is not required;
* `issue_create` is not a required `github` operation;
* PR merge is not a required first-class `github` operation;
* PR comment/edit/review/close operations do not need new model tools;
* mutation through `issue://` or `pr://` is prohibited.

OMP remains GitHub-specific today; a generic forge abstraction has been proposed upstream but is not its current architecture.

---

# 4. Required runtime dependencies

## 4.1 Mandatory

The package MUST detect:

```text
git
gh
```

`git` is required for Git functionality.

`gh` is required for the GitHub subsystem.

GitHub operations MUST use the user's existing `gh` authentication rather than implementing an independent OAuth/token store.

The extension MUST support:

```bash
gh auth login
gh auth status
```

as the normal authentication path.

If `gh` is unavailable:

* normal Git functionality MUST continue working;
* GitHub virtual resources MUST return a clear dependency error;
* the `github` model tool SHOULD not be registered.

OMP similarly gates its GitHub capability on the availability of the GitHub CLI.

---

# 5. Package architecture

Recommended source layout:

```text
pi-omp-git/
├── package.json
├── src/
│   ├── index.ts
│   │
│   ├── github/
│   │   ├── tool.ts
│   │   ├── schema.ts
│   │   ├── runner.ts
│   │   ├── repo.ts
│   │   ├── file-read.ts
│   │   │
│   │   ├── resources/
│   │   │   ├── router.ts
│   │   │   ├── parser.ts
│   │   │   ├── issues.ts
│   │   │   ├── prs.ts
│   │   │   └── render.ts
│   │   │
│   │   ├── diff/
│   │   │   ├── fetch.ts
│   │   │   ├── parse.ts
│   │   │   ├── fallback.ts
│   │   │   └── render.ts
│   │   │
│   │   ├── search/
│   │   │   ├── query.ts
│   │   │   ├── dates.ts
│   │   │   └── format.ts
│   │   │
│   │   ├── pr/
│   │   │   ├── create.ts
│   │   │   ├── checkout.ts
│   │   │   ├── push.ts
│   │   │   └── metadata.ts
│   │   │
│   │   ├── actions/
│   │   │   ├── watch.ts
│   │   │   ├── jobs.ts
│   │   │   └── logs.ts
│   │   │
│   │   └── cache/
│   │       ├── db.ts
│   │       ├── auth-key.ts
│   │       ├── policy.ts
│   │       └── invalidation.ts
│   │
│   ├── git/
│   │   ├── runner.ts
│   │   ├── repository.ts
│   │   ├── status.ts
│   │   ├── diff.ts
│   │   ├── patch.ts
│   │   └── worktree.ts
│   │
│   ├── tui/
│   │   ├── git-app.ts
│   │   ├── sidebar.ts
│   │   ├── diff-view.ts
│   │   ├── minimap.ts
│   │   ├── commit-editor.ts
│   │   └── ai-stage.ts
│   │
│   ├── commit/
│   │   ├── agent.ts
│   │   ├── overview.ts
│   │   ├── file-analysis.ts
│   │   ├── proposal.ts
│   │   ├── split.ts
│   │   ├── changelog.ts
│   │   └── execute.ts
│   │
│   └── shared/
│       ├── errors.ts
│       ├── limits.ts
│       ├── subprocess.ts
│       └── artifacts.ts
│
├── bin/
│   └── pi-omp-git.ts
│
└── test/
    ├── github/
    ├── resources/
    ├── worktree/
    ├── actions/
    ├── git-tui/
    └── commit/
```

The GitHub transport layer and Git layer MUST be independently testable.
The package MUST be loadable by Pi: `package.json` declares `"pi": { "extensions": ["./src/index.ts"] }` and the `pi-package` keyword (a conventional `extensions/` entry is an acceptable alternative). `engines` declares `node >= 22.19`, matching Pi's own requirement.

---

# 6. Upstream Pi integration

Pi's extension API already supports the critical primitives needed by this design:

* custom LLM tools;
* overriding built-in tools such as `read`;
* lifecycle/tool hooks;
* custom slash commands;
* full custom TUI components;
* subprocess execution.

In particular, an extension can replace the normal `read` implementation by registering another tool named `read`, while preserving the expected result shape.

The extension SHALL register:

```text
read       overridden/wrapped
github     new model tool
/git       interactive command
/commit    commit workflow command
```

It SHOULD also ship a companion executable:

```text
pi-omp-git
```

with subcommands:

```text
pi-omp-git git
pi-omp-git commit
```

This is necessary for exact standalone-command parity because a normal Pi extension can register `/git` inside Pi but cannot turn arbitrary words into new top-level `pi` CLI subcommands.

---

# 7. `read` override architecture

The extension MUST override Pi's built-in `read`.

Pseudo-flow:

```text
read(path, offset?, limit?)
       │
       ├── issue://... ──► GitHubResourceRouter
       │
       ├── pr://...    ──► GitHubResourceRouter
       │
       └── everything else
                │
                └──► upstream createReadTool(cwd)
```

No behavior of normal Pi filesystem reads may regress.

The wrapper MUST preserve Pi's native `ReadToolDetails` result shape.

It MUST honor Pi's native read discipline after an internal GitHub resource has been rendered: `offset`/`limit` semantics, the native truncation caps (2000 lines / 50 KB) with the standard continuation notice (`[N more lines. Use offset=X to continue.]`), and out-of-range offset errors identical to native reads.

Pagination slices the **rendered snapshot** bound to the current cache row: a cache refresh swaps the row for future reads and never shifts lines under the current one. When a paginated read lands on a row version different from the one last served for that resource in this session, the result MUST begin with a notice that the resource was updated and pagination may need to restart. Rendered virtual resources are text; image content blocks apply to `file_read` (§21) only.

Example:

```text
read({
  path: "pr://123",
  offset: 150,
  limit: 100
})
```

means:

1. resolve the entire immutable PR resource;
2. render it;
3. apply pagination;
4. return the requested lines.

---

# 8. Virtual GitHub URI grammar

The parser MUST support the following.

## 8.1 Issue resources

```text
issue://
issue://123
issue://owner/repo
issue://owner/repo/123
issue://github.example.com/owner/repo
issue://github.example.com/owner/repo/123
```

## 8.2 PR resources

```text
pr://
pr://123
pr://owner/repo
pr://owner/repo/123
pr://github.example.com/owner/repo
pr://github.example.com/owner/repo/123
```

## 8.3 PR diff resources

```text
pr://123/diff
pr://123/diff/1
pr://123/diff/2
pr://123/diff/all

pr://owner/repo/123/diff
pr://owner/repo/123/diff/1
pr://owner/repo/123/diff/all
```

Diff file indices MUST be 1-based.

OMP uses exactly this conceptual interface: bare resources browse; numbered resources show an item; `/diff` lists changed files; `/diff/N` reads one diff section; `/diff/all` returns the unified diff.

---

# 9. Resource validation

The URI parser MUST reject:

```text
.
..
empty path segments
negative PR/issue numbers
zero PR/issue numbers
invalid percent encoding
invalid diff indices
unexpected suffixes
```

Examples:

```text
pr://123/diff/0          → error
pr://123/diff/-1         → error
pr://123/foo             → error
issue://owner/../123     → error
```

`diff` MUST be rejected for issue resources.

Resources MUST be read-only: no write operations exist through the `issue://` or `pr://` schemes. Read-only describes the interface, not the content — server-side state may change, and cached representations refresh (§56). (Renamed from “immutable”, which conflated agent-non-editable with never-changing.)

---

# 10. List-resource query parameters

Bare and repository-scoped listing resources MUST accept:

```text
state
limit
author
label
```

Examples:

```text
issue://?state=open
issue://?state=closed&limit=20
issue://owner/repo?author=alice
issue://owner/repo?label=bug

pr://?state=merged
pr://?state=all&limit=50
```

Issue states:

```text
open
closed
all
```

PR states:

```text
open
closed
merged
all
```

Defaults:

```text
state = open
limit = 30
```

Maximum listing limit:

```text
100
```

Values beyond the maximum SHOULD be clamped rather than allowing unbounded output.

List resources SHOULD be fetched live rather than cached.

---

# 11. Single issue rendering

`read issue://N` MUST render a stable Markdown representation containing, when available:

```text
# <number> <title>

State
State reason
Author
Created
Updated
Labels
URL

## Body

...

## Comments

...
```

Required GitHub data includes:

```text
number
title
state
stateReason
author
body
labels
createdAt
updatedAt
url
comments
```

Minimized comments SHOULD not be included.

For compatibility with older `gh` versions, failure caused specifically by an unsupported JSON field such as `stateReason` SHOULD retry with the unsupported field omitted.

---

# 12. Single PR rendering

`read pr://N` MUST render:

```text
# <number> <title>

State
Draft
Author
Base
Head
Review decision
Merge state
Created
Updated
Labels
URL

## Body

...

## Files

...

## Reviews

...

## Review Comments

...

## Comments

...

## Diff

pr://N/diff
```

Required information includes:

```text
number
title
state
isDraft
author
baseRefName
headRefName
reviewDecision
mergeStateStatus
body
labels
files
reviews
comments
createdAt
updatedAt
url
```

A PR that has no ordinary conversation comments MUST still render reviews/review comments where present.

The normal files preview SHOULD be capped at 50 files, matching OMP's current preview limit.

---

# 13. Review comments

Line-level PR review comments MUST be collected separately from ordinary PR comments.

Use the equivalent of:

```text
GET /repos/{owner}/{repo}/pulls/{number}/comments
```

Pagination MUST use pages of up to 100 comments.

Normalize at least:

```ts
interface ReviewComment {
  id: number;
  author?: string;
  body: string;
  createdAt?: string;
  inReplyToId?: number;
  path?: string;
  line?: number;
  originalLine?: number;
  side?: string;
  url?: string;
}
```

Replies SHOULD retain enough metadata for a renderer to display thread relationships.

---

# 14. Comment suppression

Single-resource reads MUST support:

```text
?comments=0
?comments=false
```

For example:

```text
read pr://782?comments=0
```

This MUST omit:

* ordinary comments;
* review comments where the OMP no-comments representation omits them;
* other expensive discussion material.

It SHOULD preserve core PR metadata and file summary.

The comments flag MUST be part of the cache identity.

---

# 15. PR diff behavior

The implementation MUST cache one normalized diff object and derive all three views from it.

Internal shape:

```ts
interface CachedPrDiff {
  unifiedDiff: string;
  files: DiffFileIndex[];
}

interface DiffFileIndex {
  index: number;
  path: string;
  oldPath?: string;
  changeType?: string;
  additions?: number;
  deletions?: number;
  binary: boolean;
  startIndex: number;
  endIndex: number;
}
```

Then:

```text
/diff
```

renders the index.

```text
/diff/3
```

slices `startIndex..endIndex` — UTF-16 code-unit offsets into the cached `unifiedDiff`. (Renamed from `startByte`/`endByte`, which mislabeled string offsets as byte offsets.)

```text
/diff/all
```

returns `unifiedDiff`.

Only one network fetch SHOULD occur for repeated reads of those three representations while the cache row is valid.

---

# 16. Primary diff fetch

First attempt:

```bash
gh pr diff <number> --color never --repo <repo>
```

The returned unified diff SHOULD be retained verbatim.

Parsing MUST recognize file boundaries beginning with:

```text
diff --git
```

and support:

* modified files;
* added files;
* deleted files;
* renamed files;
* binary files.

---

# 17. Large-diff fallback

GitHub may reject aggregate PR diff generation for sufficiently large diffs.

If the aggregate fetch fails because the diff is too large, the implementation MUST:

1. fetch the changed-file list through the GitHub API;
2. paginate it;
3. obtain available per-file patch bodies;
4. construct a deterministic synthetic unified representation;
5. clearly represent files for which GitHub does not provide a patch.

Examples:

```text
Binary file; patch unavailable.
```

or:

```text
Patch unavailable from GitHub for this file.
```

The entire PR read MUST NOT fail solely because one file has no patch.
Hard boundary: GitHub caps the per-file listing API at 3,000 files. If the changed-file list exceeds that limit, the fallback MUST fail with a clear error naming the limit and the PR; it MUST NOT silently truncate. §93 covers this outcome.

---

# 18. GitHub model operation surface

The semantic `github` dispatcher MUST support:

```text
repo_view
file_read
pr_create
pr_checkout
pr_push
search_issues
search_prs
search_code
search_commits
search_repos
run_watch
```

Note that current OMP builds may expose this dispatcher through their `xd://github` discovery layer. For upstream Pi the implementation SHOULD expose a normal `github` custom tool because Pi already has an efficient extension-tool mechanism. The wire semantics should remain the same. OMP's current GitHub subsystem includes repository/PR operations, five searches, dedicated PR worktrees and Actions watching.

Recommended parameter schema:

```ts
{
  op:
    | "repo_view"
    | "file_read"
    | "pr_create"
    | "pr_checkout"
    | "pr_push"
    | "search_issues"
    | "search_prs"
    | "search_code"
    | "search_commits"
    | "search_repos"
    | "run_watch",

  repo?: string,
  branch?: string,
  path?: string,

  pr?: string | string[],
  force?: boolean,
  forceWithLease?: boolean,

  title?: string,
  body?: string,
  base?: string,
  head?: string,
  draft?: boolean,
  fill?: boolean,
  reviewer?: string[],
  assignee?: string[],
  label?: string[],

  query?: string,
  since?: string,
  until?: string,
  dateField?: "created" | "updated",
  limit?: number,

  run?: string,
  commit?: string,
  tail?: number
}
```

---

# 19. Repository identifier format

The GitHub subsystem MUST accept:

```text
owner/repo
host/owner/repo
```

Examples:

```text
mariozechner/pi-mono
github.acme.internal/platform/backend
```

The host-qualified form is necessary for GitHub Enterprise.

When the current checkout resolves to the relevant GitHub host, explicit `repo` MAY be omitted.

---

# 20. `repo_view`

Input:

```json
{
  "op": "repo_view",
  "repo": "owner/repo",
  "branch": "optional"
}
```

The result SHOULD include:

```text
owner/name
description
canonical URL
default branch
requested branch, if any
visibility
viewer permission
primary language
stars
forks
archived status
fork status
last update time
homepage
topics
```

If `repo` is omitted, `gh` repository resolution is used.

---

# 21. `file_read`

Input:

```json
{
  "op": "file_read",
  "repo": "owner/repo",
  "path": "src/foo.ts",
  "branch": "main"
}
```

Rules:

* `path` is mandatory;
* it MUST be repository-relative;
* leading `/` MUST be rejected;
* path segments MUST be individually URL encoded before GitHub API requests;
* branch omission means repository default branch;
* repo omission means current GitHub checkout.

Text content SHALL be decoded and returned directly.

Binary content MUST NOT be turned into mojibake.

For recognized image content, the implementation SHOULD return image-capable Pi content blocks when possible.

For unsupported binary content, return metadata plus the GitHub source URL.

The model prompt SHOULD explicitly tell the agent to use `file_read` rather than `curl`/`wget` for GitHub-hosted repository files.

---

# 22. `pr_create`

Required:

```text
fill=true
```

or:

```text
title
```

Optional:

```text
repo
body
base
head
draft
reviewer[]
assignee[]
label[]
```

Rules:

```text
fill + title → invalid
fill + explicit body → invalid
```

If `head` is omitted, use the current branch where possible.

A nonempty PR body SHOULD be written to a temporary file and supplied through:

```bash
gh pr create --body-file <temp>
```

rather than interpolated into a shell command.

An explicitly empty body MUST result in noninteractive behavior such as:

```bash
--body ""
```

so `gh` never opens an editor unexpectedly.

After successful creation:

1. parse the returned PR URL;
2. best-effort fetch the newly created PR;
3. return a rich summary;
4. retain the canonical PR URL in structured details.

Failure of the optional post-create refresh MUST NOT turn a successfully created PR into an error.

---

# 23. PR checkout: fundamental invariant

`pr_checkout` MUST NEVER replace or mutate the user's current working-tree checkout merely to inspect a PR.

Every PR MUST live in a dedicated Git worktree.

This is one of the most important OMP Git behaviors. Current OMP places PRs in dedicated worktrees, persists PR push metadata in branch config, and can batch checkout operations.

---

# 24. `pr_checkout` accepted identifiers

`pr` MUST accept:

```text
"123" (text — JSON numbers are rejected)
"https://github.com/owner/repo/pull/123"
branch-like PR identifier accepted by gh
```

It MUST additionally accept:

```ts
pr: string[]
```

for batching.

If omitted, resolving the PR associated with the current branch MAY be attempted.

Batch mode MUST permit partial success.

Use a result conceptually like:

```ts
{
  checkouts: [
    {
      pr: "123",
      branch: "pr-123",
      worktreePath: "...",
      reused: false
    }
  ],
  failures: [...]
}
```

One failed PR MUST NOT roll back unrelated successful worktrees.
Partial-success contract: when at least one checkout succeeds, the tool result is a success whose body contains both `checkouts[]` and `failures[]`, each failure carrying a §90 error class. When no checkout succeeds, the tool returns an error with the same structured body (divergence D4, §108).

---

# 25. PR local branch naming

The local PR branch MUST be:

```text
pr-<number>
```

Examples:

```text
pr-5
pr-914
```

Do not derive the local name from the contributor's remote branch.

---

# 26. PR worktree location

Default root:

```text
~/.pi/agent/worktrees/
```

Recommended parity-style naming:

```text
<number>-<7-char-repo-root-hash>
```

Example:

```text
~/.pi/agent/worktrees/914-a01c72e
```

Configuration MUST permit changing the worktree root.

Suggested environment override:

```text
PI_OMP_GIT_WORKTREE_DIR
```

The package MAY additionally accept:

```text
OMP_WORKTREE_DIR
```

for OMP migration compatibility.

OMP itself defaults its managed worktrees under `~/.omp/wt` and exposes an environment override.

---

# 27. Worktree collision handling

Before creating a worktree, inspect:

```bash
git worktree list --porcelain
```

If the preferred path is occupied by an unrelated worktree or filesystem entry:

```text
914-a01c72e
914-a01c72e-2
914-a01c72e-3
...
```

The implementation SHOULD attempt a bounded number of suffixes and fail clearly if no path is available.

Existing worktree detection SHOULD primarily use the branch reference:

```text
refs/heads/pr-<number>
```

rather than path identity.

---

# 28. Existing local PR branches

If:

```text
refs/heads/pr-123
```

exists at the expected PR SHA, reuse it.

If it exists at a different SHA:

```text
force = false
```

MUST fail with a clear conflict.

```text
force = true
```

MAY force-reset the local PR branch to the resolved PR head before checkout.

No silent reset is allowed.
This failure-on-mismatch is divergence D2 (§108): current OMP reuses an existing worktree without checking the branch SHA.

---

# 29. Cross-repository PRs

For same-repository PRs:

```text
remote = origin
```

is preferred.

For fork PRs, the implementation MUST resolve a push-capable head-repository remote.

Recommended names:

```text
fork-alice
fork-alice-2
fork-alice-3
```

If an existing remote already points to the correct head repository, reuse it.

When choosing a clone URL for a fork, prefer the transport style already used by `origin`:

```text
HTTPS origin → prefer HTTPS
SSH origin   → prefer SSH
```

This avoids changing the user's authentication model.

---

# 30. PR branch metadata

After checkout, persist the equivalent of OMP's branch metadata:

```text
branch.pr-123.remote
branch.pr-123.merge
branch.pr-123.pushRemote

branch.pr-123.ompPrHeadRef
branch.pr-123.ompPrUrl
branch.pr-123.ompPrIsCrossRepository
branch.pr-123.ompPrMaintainerCanModify
```

Use these exact OMP-compatible keys unless there is a compelling reason not to.

That enables interoperability and makes `pr_push` deterministic.

---

# 31. Repository mutation lock

All Git mutations affecting shared repository metadata MUST be serialized by **primary repository root**, not by individual worktree directory.

Reasons include shared:

```text
.git/config
refs
packed-refs
worktree metadata
commit graph
```

Parallel metadata mutations issued through this extension MUST NOT race. The guarantee is scoped: another Pi instance or an ordinary Git process is not serialized by the in-process mutex and is bounded only best-effort by the cross-process lock.

A per-repository async mutex is sufficient within one Pi process.

Cross-process locking SHOULD use an advisory lockfile at `<repo-root>/.git/pi-omp-git.lock` where the platform supports it.

---

# 32. `pr_push`

`pr_push` MUST require a branch that has previously been prepared by `pr_checkout`.

If the branch lacks:

```text
branch.<name>.ompPrHeadRef
```

return an error equivalent to:

```text
This branch has no PR checkout metadata.
Use pr_checkout before pr_push.
```

Do not guess a contributor branch.
Target resolution (§110): explicit `pr` (text) or `branch` parameter → the session’s last checkout (transcript-derived, survives resume) → current-branch metadata → `PrMetadataMissingError`. `pr_push` accepts a single PR; the array form of `pr` is rejected here.

---

# 33. PR push refspec

Resolve:

```text
local branch
push remote
remote PR head ref
PR URL
```

If the target branch is currently checked out:

```text
source = HEAD
```

otherwise:

```text
source = refs/heads/<localBranch>
```

Then push:

```text
<source>:refs/heads/<ompPrHeadRef>
```

Support:

```text
forceWithLease: true
```

via:

```bash
--force-with-lease
```

Never implement plain `--force` as a substitute.

Successful push MUST invalidate all cached views/diffs for that PR.

---

# 34. GitHub search operations

Required:

```text
search_issues
search_prs
search_code
search_commits
search_repos
```

Search SHOULD use `gh api` directly so GitHub query syntax reaches the API without another CLI layer altering query semantics. OMP uses this approach for its searches.

---

# 35. Search limits

Default:

```text
10
```

Maximum:

```text
50
```

The implementation MUST:

* reject non-finite limits;
* reject values `<= 0`;
* floor noninteger values;
* clamp above 50.

These match current OMP limits.

---

# 36. Default repository scoping

For:

```text
search_issues
search_prs
search_code
search_commits
```

when no `repo` is supplied, the implementation SHOULD resolve the current GitHub checkout and implicitly append:

```text
repo:owner/repo
```

Do NOT add that qualifier when the query already contains a broad explicit scope such as:

```text
repo:
org:
user:
owner:
```

If current repository resolution fails, allow the search to proceed globally when GitHub semantics permit it.

`search_repos` MUST ignore the `repo` parameter.

---

# 37. Search date grammar

Support:

```text
3m
12h
7d
2w
3mo
1y
```

plus:

```text
YYYY-MM-DD
ISO-8601 datetime
```

Interpret relative expressions relative to invocation time.

`since` is a lower bound.

`until` is an upper bound.

---

# 38. `dateField`

Allowed:

```text
created
updated
```

Default:

```text
created
```

Mapping:

### Issues / PRs

```text
created → created:
updated → updated:
```

### Repositories

```text
created → created:
updated → pushed:
```

### Commits

Always use:

```text
committer-date:
```

The supplied `dateField` does not alter that.

### Code

`since` and `until` MUST be rejected.

---

# 39. Search result rendering

Search results MUST prioritize information useful to an agent rather than dumping raw JSON.

### Issue/PR

```text
number
title
repository
state
author
labels
created/updated time
URL
```

### Code

```text
path
repository
short SHA
URL
first useful text-match fragment
```

### Commit

```text
short SHA
first message line
repository
author
date
URL
```

### Repository

```text
name
description
language
stars
forks
open issue count
visibility
archived/fork state
updated time
URL
```

Canonical GitHub URLs MUST always be included.

---

# 40. `run_watch`

Two modes are required:

```text
run mode
commit mode
```

### Run mode

User provides:

```json
{
  "op": "run_watch",
  "run": "1234567"
}
```

or a GitHub Actions run URL.

### Commit mode

User omits `run`.

The implementation resolves:

```text
current HEAD SHA
repository
optional/current branch
```

and discovers all workflow runs for that commit.

The query MUST be SHA-oriented, not merely branch-oriented, because PR/tag triggered workflows may otherwise be missed.
Commit mode accepts an optional `commit` (SHA) or `pr` parameter. Resolution (§110): explicit parameter → the head SHA of the session’s last checkout → current HEAD. `run_watch` accepts a single PR; the array form of `pr` is rejected here.

---

# 41. Actions polling behavior

Parity defaults:

```text
initial poll interval    3 seconds
fast polling window     60 seconds
slow poll interval      15 seconds
no-runs timeout         90 seconds
max poll failures       5
failure grace period     5 seconds
```

OMP currently uses these values.

Polls MUST honor the tool's AbortSignal.

Rate-limit errors SHOULD be treated as transient until the failure budget is exhausted.

---

# 42. Actions completion semantics

The following conclusions count as successful:

```text
success
neutral
skipped
```

Failure-like outcomes include:

```text
failure
timed_out
cancelled
action_required
startup_failure
```

When a failed job is first detected:

1. emit an update immediately;
2. wait the 5-second failure grace period;
3. refetch state;
4. collect all contemporaneous failed jobs.

This improves the chance that parallel failures appear in the same result.

---

# 43. Late Actions runs

In commit mode, the watcher MUST NOT return success immediately when all currently observed runs become green.

It MUST:

1. capture the set of known run IDs;
2. wait one additional poll interval;
3. fetch again;
4. return success only if no new runs appeared and all observed runs remain successful.

OMP deliberately uses this stabilization behavior so a late workflow associated with the same commit is not missed.

---

# 44. Actions failure logs

For failed jobs:

* fetch the captured job logs (bounded by §48’s 8 MiB output cap);
* inline only a tail;
* persist the captured logs separately.

Defaults:

```text
tail = 15 lines
max tail = 200 lines
```

Pi provides no artifact facility; file-based artifacts under the path below are the primary mechanism.

Otherwise save beneath:

```text
~/.pi/agent/artifacts/pi-omp-git/
```

and return the absolute or session-relative artifact reference.

A failed log download MUST NOT fail the entire run watcher.

Instead:

```text
Log unavailable.
```

---

# 45. Streaming Actions UI

`run_watch` SHOULD use Pi's tool update callback.

Progress view SHOULD display:

```text
repository
branch/SHA
workflow
run ID
status
elapsed time
jobs
job conclusions
```

Failed jobs SHOULD become visible immediately.

The final result remains valid plain text even if the custom renderer is unavailable.

---

# 46. GitHub subprocess runner

There MUST be one centralized GitHub process runner.

Never construct:

```ts
exec(`gh ${userInput}`)
```

Instead execute:

```ts
pi.exec("gh", args, ...)
```

or the equivalent subprocess API with an argument array.

This prevents shell interpolation/injection.

---

# 47. GitHub process environment

All noninteractive GitHub operations SHOULD set equivalents of:

```text
GH_PROMPT_DISABLED=1
GIT_TERMINAL_PROMPT=0
GIT_EDITOR=true
GIT_ASKPASS=true
```

SSH askpass MUST be disabled in a portable manner.

Locale SHOULD be stabilized for outputs that are parsed:

```text
LC_ALL=C
LANG=C
```

Do not overwrite authentication variables supplied by the user.

---

# 48. GitHub process limits

Recommended parity limits:

```text
timeout      5 minutes
output cap   8 MiB
```

When output exceeds the cap:

* truncate safely;
* say that truncation happened;
* save the captured (possibly truncated) content to an artifact where useful — bytes past the cap are discarded, so “complete” is never promised.

Cancellation MUST terminate the underlying child process.

---

# 49. Friendly errors

Map common low-level failures into stable messages.

### Missing `gh`

```text
GitHub CLI (gh) is not installed.
```

### Authentication

```text
GitHub CLI is not authenticated. Run `gh auth login`.
```

### No current GitHub repository

```text
GitHub repository context is unavailable.
Pass `repo` explicitly or run inside a GitHub checkout.
```

### Invalid JSON response

```text
GitHub CLI returned invalid JSON.
```

Include useful stderr after sanitization.

Never echo tokens.

---

# 50. GitHub Enterprise

A GitHub identity MUST internally be:

```ts
interface GithubRepo {
  host: string;
  owner: string;
  repo: string;
}
```

Do not assume:

```text
host === github.com
```

All API URLs, repository resolution, cache keys and canonical links MUST retain host information.

A PR URL provided as an identifier takes precedence over a separate inferred repository.

If explicit `repo` conflicts with a run URL or PR URL, return an error rather than operating on the wrong repository.

---

# 51. GitHub cache

Use SQLite.

Default location:

```text
~/.pi/agent/cache/pi-omp-git/github-cache.db
```

Optional compatibility environment variable:

```text
PI_OMP_GITHUB_CACHE_DB
```

The implementation MAY also honor:

```text
OMP_GITHUB_CACHE_DB
```

for users migrating from OMP.

OMP itself stores GitHub rendered views and raw data in a SQLite cache and permits the database path to be overridden.
Driver: `node:sqlite`, unflagged on every Node version Pi supports (≥ 22.13). Probe for availability at startup; on failure, degrade to uncached operation (§55). No native (node-gyp) dependency is acceptable for a package installed via `pi install`.

---

# 52. Cache policy

Parity defaults:

```text
enabled       true
soft TTL      300 seconds
hard TTL      604800 seconds
```

That is:

```text
5 minutes
7 days
```

OMP's current defaults use the same values.

---

# 53. Cache identity

Cache rows MUST be scoped by:

```text
credential identity
host
repository
resource kind
resource number
comments mode
```

At minimum:

```text
auth_key
host
repo
kind
number
include_comments
```

Kinds:

```text
issue
pr
pr-diff
```

Private GitHub content MUST never leak between two GitHub identities using the same machine.

---

# 54. Credential fingerprint

Never persist a GitHub token itself.

Construct an authentication fingerprint using available credential material, then hash it with a cryptographic hash such as SHA-256.

Store only the digest.

Sources MAY include:

* relevant GitHub token environment variables;
* `gh` authenticated-host configuration.

If a reliable credential identity cannot be produced, caching SHOULD be bypassed rather than risk cross-account leakage.

---

# 55. Cache file permissions

On Unix-like platforms:

```text
cache directory 0700
database         0600
WAL              0600
SHM              0600
```

Initialize SQLite with:

```text
journal_mode = WAL
synchronous = NORMAL
busy_timeout = 5000
```

Cache failure MUST degrade to uncached GitHub operation.

A corrupted cache MUST NOT make GitHub unusable.

---

# 56. Cache freshness algorithm

Pseudo-code:

```text
if cache disabled:
    fetch live

row = lookup()

if no row:
    fetch live
    store
    return

age <= softTTL:
    return cached

softTTL < age <= hardTTL:
    if resource == pr-diff:
        return stale
        schedule deduplicated background refresh
    else:
        try refresh synchronously
        if refresh works:
            return fresh
        else:
            return stale + warning

age > hardTTL:
    remove row
    fetch live
```

Stale output SHOULD visibly say that refresh failed when applicable.

Background refreshes for the same cache identity MUST be deduplicated.

---

# 57. Cache invalidation after GitHub mutations

The package MUST proactively invalidate relevant rows when it knows GitHub changed.

Examples:

```text
pr_push
PR edits performed through shell gh
PR comments
PR reviews
PR merge
issue edit
issue close/reopen
issue comments
```

The invalidation strategy SHOULD deliberately over-invalidate rather than leave stale content.

---

# 58. Shell `gh` mutation detection

Subscribe to Pi `bash` tool results and interactive `user_bash` events. When a command *contains* a recognizable mutation, invalidate the relevant rows **before** executing it — invalidation on detection, not on success, so failed or timed-out commands still over-invalidate (§57). Mutations performed through this extension’s own tools invalidate after confirmed success.

When the command contains recognizable operations such as:

```text
gh issue close
gh issue reopen
gh issue edit
gh issue comment
gh issue delete
gh issue lock
gh issue unlock
gh issue pin
gh issue unpin
gh issue transfer

gh pr close
gh pr reopen
gh pr merge
gh pr ready
gh pr edit
gh pr comment
gh pr review
gh pr lock
gh pr unlock
```

attempt to identify:

```text
host
repo
issue/PR number
```

Then invalidate narrowly.

If mutation is clearly detected but exact number cannot be established:

```text
invalidate all issue/PR rows for the repository
```

Do not under-invalidate in order to be clever.

Parsing MUST NOT execute or reinterpret the shell string.

It is only an invalidation heuristic.
Observable scope: GitHub mutations performed outside Pi-observed commands — other terminals, other processes, the GitHub web UI — are undetectable from this extension. Guaranteed detection of all GitHub changes is impossible; the TTL policy (§52) is the backstop.

---

# 59. Prompt integration

When `github` is active, append concise Pi tool guidelines equivalent to:

```text
- Read GitHub issues and PRs through issue:// and pr:// resources.
- Use pr://N/diff for the changed-file index, pr://N/diff/I for one file,
  and pr://N/diff/all only when the complete diff is required.
- Use GitHub file_read instead of curl/wget for files stored in GitHub repos.
- Use GitHub search operations rather than scraping GitHub search pages.
- Use pr_checkout to inspect or modify PRs; it creates isolated worktrees.
- Use pr_push for branches created by pr_checkout.
- After pr_checkout, edit files using absolute paths under the returned worktreePath;
  pr_push and run_watch default to the session’s last checkout.
- Use run_watch to monitor GitHub Actions.
```

Do not inflate the system prompt with full schemas when the normal Pi tool schema already provides them.
Append these guidelines through Pi’s system-prompt build hook (`systemPromptOptions`), not by rewriting the prompt.

---

# 60. Interactive Git interface

The extension MUST supply:

```text
/git
```

inside Pi.

A companion executable SHOULD supply:

```bash
pi-omp-git git
```

The standalone mode SHOULD accept:

```text
[revision]
-C <directory>
```

Conceptually equivalent to:

```bash
omp git [revision] [-C dir]
```

The command requires an interactive TTY.
The companion binary reuses the published `@earendil-works/pi-tui` component library, so the TUI renders identically in both hosts.

---

# 61. Git TUI layout

Primary layout:

```text
┌─────────────────────────────────────────────────────────┐
│ Repository / branch / HEAD                              │
├───────────────────┬─────────────────────────────────────┤
│ Files             │ Diff                                │
│                   │                                     │
│ Staged            │ old                  new            │
│  M src/a.ts       │ ...                  ...            │
│  A src/b.ts       │                                     │
│                   │                                     │
│ Unstaged          │                                     │
│  M src/c.ts       │                                     │
│                   │                                     │
├───────────────────┴─────────────────────────────────────┤
│ actions / status / commit composer                      │
└─────────────────────────────────────────────────────────┘
```

The diff pane SHOULD offer a minimap or equivalent compact position indicator.

---

# 62. Git model

Maintain explicit state:

```ts
interface GitUiState {
  root: string;
  branch?: string;
  head?: string;

  staged: GitFile[];
  unstaged: GitFile[];
  conflicts: GitFile[];

  selection: {
    area: "staged" | "unstaged" | "commit";
    file?: string;
    hunk?: number;
  };

  revision?: string;
}
```

Refresh state after every mutation.

Never infer success solely from process exit text; re-read repository state.

---

# 63. Git file states

Support at least:

```text
modified
added
deleted
renamed
copied
untracked
conflicted
binary
LFS pointer
```

Display both staged and unstaged state when one path has both.

---

# 64. File-level operations

For an unstaged file:

```text
stage
discard
```

For a staged file:

```text
unstage
discard
```

For an untracked file:

```text
stage
delete/discard
```

Destructive discard MUST require explicit UI intent.

Conflicted files MUST NOT be blindly discarded/staged by operations intended for ordinary files.

---

# 65. Hunk-level operations

For textual diffs support:

```text
stage hunk
unstage hunk
discard hunk
```

Implementation SHOULD use Git patch primitives:

```bash
git apply --cached
git apply --cached --reverse
git apply --reverse
```

or equivalent plumbing with generated patches.

Before applying a generated hunk patch:

1. validate it;
2. verify the target repository state;
3. apply;
4. refresh status;
5. surface any rejection.

No partially applied patch should be reported as success.

---

# 66. Staged-file discard semantics

A staged file may simultaneously contain unstaged modifications.

Discard behavior MUST be clearly differentiated from unstage.

For an explicit **discard all changes in file** action:

* restore the index to HEAD;
* restore working-tree content appropriately;
* remove untracked files when specifically requested.

The UI MUST state that unstaged modifications to that same path will also be lost before performing this destructive operation.

---

# 67. Revision mode

If launched with:

```bash
pi-omp-git git <revision>
```

the UI enters revision inspection mode.

This view SHOULD:

* resolve the specified commit/ref;
* list files changed by that commit;
* display parent-versus-revision diffs;
* disable working-tree stage/unstage/discard commands.

Revision mode is read-only.

---

# 68. Large files

Avoid loading arbitrarily large files into the TUI.

Parity target:

```text
4 MiB per ordinary diffable file
```

Above that limit, show:

```text
File too large for interactive content preview.
```

Git metadata and change status should remain visible.

---

# 69. Binary and image diffs

For binary files:

* clearly indicate binary status;
* do not decode arbitrary bytes as UTF-8.

If terminal image rendering is supported, recognized image changes MAY display previews.

SVG SHOULD be rasterized only with resource limits.

Git LFS pointer files SHOULD be recognized so the UI does not misrepresent the pointer text as the actual binary object's meaningful content.

---

# 70. AI Stage

The Git UI MUST support an action equivalent to OMP's AI Stage.

User provides a natural-language instruction such as:

```text
Stage only the changes related to retry handling.
```

The system then:

1. reads all relevant unstaged diffs;
2. identifies matching files/hunks;
3. produces a staging plan;
4. stages only selected hunks/files;
5. leaves unrelated changes untouched;
6. refreshes Git status.

For textual partial matches, use generated patches.

For binary or inherently indivisible changes, the AI decision is file-level.

AI staging MUST NOT commit automatically.
AI Stage runs as a nested agent session (§75, ADR 0004): read-only Git tools plus a staging-plan proposal tool. The TUI displays the plan, and §71’s verification applies after the user confirms it.

---

# 71. AI staging safety

Before AI-selected staging:

```text
snapshot index tree
snapshot status
```

After application:

* verify all intended hunks are staged;
* verify rejected hunks remain unstaged;
* if the operation fails halfway, attempt to restore the index snapshot.

The working tree MUST not lose content as a side effect of AI staging.

---

# 72. Commit composer in Git TUI

The TUI MUST provide:

```text
manual commit message
AI-generated commit message
amend mode
```

Generated messages SHOULD follow Conventional Commits by default:

```text
type(scope): summary
```

with optional body.

The user MUST be able to edit the generated text before execution.

Commit hooks MUST run normally.

---

# 73. Agentic `/commit`

The extension MUST register:

```text
/commit
```

and the companion binary SHOULD expose:

```bash
pi-omp-git commit
```

Supported options:

```text
--push
--dry-run
--no-changelog
--context <text>
--model <model>
```

A compatibility option MAY expose:

```text
--legacy
```

if both the agentic and deterministic commit algorithms are implemented.

These correspond to the current OMP commit command surface. Current OMP's agentic pipeline performs a Git overview, can fan out file analysis, proposes either a single or split commit plan, and only executes Git commits after proposal generation.

---

# 74. Commit preparation

The pipeline MUST first determine:

```text
repository root
HEAD
branch
staged status
unstaged status
untracked files
```

If staged files exist:

```text
operate on the staged set
```

If no files are staged but the working tree contains changes, compatibility mode MAY stage all changes before proposal generation — never in dry-run (divergence D1, §108): dry-run analysis reads the combined view (`git diff HEAD` plus untracked files) without touching the index or working tree.

The behavior must be clearly reported.

A clean working tree MUST not produce a fake commit.

---

# 75. Commit-agent tool surface

The internal commit agent is a nested headless session created through the SDK (`createAgentSession({ cwd, noTools: "all" })`) — one pipeline implementation, two hosts: the `/commit` command runs it in-process and the `pi-omp-git commit` binary runs it standalone (ADR 0004). Nested sessions use a temporary session directory and never appear in the user’s session list. The agent SHOULD receive narrowly scoped tools rather than unrestricted shell access.

Recommended:

```text
git_overview
git_file_diff
git_hunk
analyze_files
propose_commit
propose_split_commit
```

### `git_overview`

Returns:

```text
status
changed files
staged/unstaged classification
diffstat
current branch
recent commit-message examples
```

### `git_file_diff`

Returns one file's relevant patch.

### `git_hunk`

Returns a precise requested hunk.

### `analyze_files`

Delegates detailed semantic analysis of selected files when required.

### Proposal tools

Return structured proposed commit plans.

---

# 76. Commit analysis policy

The parent commit agent SHOULD first inspect:

```text
overview
relevant diffs
existing repository commit style
```

Only use per-file subagent analysis when:

* a diff is unusually large;
* semantic intent is unclear;
* several independent concerns need classification.

Do not blindly spawn one expensive model session per file.

OMP currently has an `AnalyzeFiles` fan-out capable of creating per-file subagent sessions; users have identified this as potentially expensive on repositories with large context files.

For the Pi implementation, expose:

```yaml
commit:
  analyzeFilesEnabled: true
  analyzeFilesMaxFiles: 8
  analyzeFilesMaxConcurrency: 4
```

This intentionally improves operational control while preserving the capability.

---

# 77. Single commit proposal

Structured representation:

```ts
interface CommitProposal {
  type: string;
  scope?: string;
  summary: string;
  body?: string;
  files: string[];
}
```

The final message is rendered from structured data.

The summary SHOULD:

* use imperative mood;
* be concise;
* describe the intent of the changes;
* avoid generic phrases such as "update files".

---

# 78. Split commit proposal

For unrelated logical changes:

```ts
interface SplitCommitProposal {
  commits: CommitProposal[];
}
```

Requirements:

* every selected path belongs to at most one commit — split plans are file-level in this release (schema-enforced `files: string[]`); hunk-level assignment is a recorded non-goal, and a file containing unrelated concerns is placed in the dominant commit;
* every intended staged change belongs to a commit;
* ordering respects dependencies where relevant;
* each commit must be independently coherent.

Before execution display the plan in interactive mode.

In noninteractive mode, behavior MUST be explicit and configurable rather than accidentally depending on TTY detection.

Suggested configuration:

```yaml
commit:
  splitPolicy: confirm
```

Allowed:

```text
confirm
auto
never
```

---

# 79. Split commit execution

Do NOT permanently mutate the user's working tree by repeatedly checking out arbitrary revisions.

Recommended transaction:

1. snapshot original index/tree state;
2. derive patch set for commit group 1;
3. set index to only group 1;
4. commit;
5. derive group 2 against remaining changes;
6. commit;
7. repeat;
8. restore intended remaining unstaged/staged state.

Every pre-commit and commit-msg hook MUST execute for every created commit.

If commit `N` fails:

* stop immediately;
* report which commits succeeded;
* report which proposal failed;
* leave all uncommitted user changes recoverable;
* return nonzero/error status.

---

# 80. Tree-conservation invariant

The commit pipeline MUST preserve user content.

Before the operation, capture enough state to validate:

```text
working tree content
index content
untracked files involved
```

After successful split:

```text
HEAD includes all intended commit groups
working-tree residual content equals intended residual content
```

After failure:

```text
no source modification is silently lost
```

Automated tests SHOULD compare Git tree/index identities where possible.
Conservation covers the pipeline’s own mutations: pre- and post-operation snapshots (tree, index, untracked) MUST be compared, and any mismatch — including hook side-effects or external concurrent modification — MUST abort with `CommitExecutionError` rather than proceed silently.

---

# 81. Changelog integration

Unless:

```text
--no-changelog
```

the pipeline MAY identify a project changelog and propose a corresponding entry.

The changelog update MUST be included in an appropriate commit, not committed as an unrelated hidden mutation.

Expose:

```yaml
commit:
  changelog: true
  changelogMaxDiffChars: <configured value>
```

If no changelog is found, absence is not an error.

---

# 82. Dry run

`--dry-run` MUST:

* perform enough analysis to produce the displayed plan;
* print proposed commit messages;
* print split grouping;
* print changelog plan;
* execute **no** `git commit`;
* execute **no** `git push`.

It MUST return a successful dry-run result only when proposal generation itself succeeded.

Optional optimization:

```yaml
commit:
  dryRunAnalyzeFiles: false
```

to avoid expensive per-file subagents during preview.

---

# 83. Commit correctness contract

A non-dry-run command MUST satisfy exactly one of:

```text
A. one or more commits were actually created;
B. command returns failure;
C. there were definitively no changes to commit.
```

It MUST NEVER:

```text
print a proposal
exit successfully
leave staged changes unchanged
claim success without creating the intended commit
```

This distinction matters because OMP has historically had bugs where proposal generation looked successful even though the host never reached `git commit`; the clone should make actual repository state the success criterion.

After each commit verify:

```text
HEAD_before != HEAD_after
```

unless the Git command explicitly reports an expected no-op case.

---

# 84. Git hooks

Do not disable:

```text
pre-commit
prepare-commit-msg
commit-msg
post-commit
```

unless the user explicitly configures otherwise.

If a hook rejects the commit:

* preserve its stderr;
* return an error;
* identify which split-commit step failed;
* do not expose package source code or internal stack traces instead of the hook's useful message.

---

# 85. GPG/signing

Respect repository/user Git signing configuration.

Do not force a fake value such as:

```text
GPG_TTY=not a tty
```

Preserve a valid inherited `GPG_TTY`.

If signing requires interactive pinentry unavailable in the current environment, surface Git's actual error and fail.

Do not silently retry with signing disabled.

---

# 86. `--push`

After successful commit execution, `--push` MAY push.

Requirements:

* do not push before commits succeed;
* use configured upstream where possible;
* preserve Git's normal authentication;
* surface push rejection;
* do not convert non-fast-forward rejection into force push.

For PR branches created by `pr_checkout`, SHOULD use the PR metadata and equivalent `pr_push` routing.

For ordinary branches, use standard upstream configuration.

If the tree is clean but `--push` was explicitly requested, the implementation SHOULD still push already-created local commits or clearly report why no push occurred.

---

# 87. Output and artifact policy

Agent-facing GitHub and Git outputs MUST remain reasonably bounded.

Normal Pi custom-tool output SHOULD follow upstream Pi's established truncation discipline rather than flooding model context. Pi documents custom-tool truncation patterns and expects tools to preserve complete output separately when appropriate.

Large output categories:

```text
PR full diff
Actions logs
huge issue discussion
huge commit diff
```

SHOULD use artifact storage.

The inline result MUST say where complete content is available.
Artifacts are files under `~/.pi/agent/artifacts/pi-omp-git/`; Pi provides no artifact facility (§44).

---

# 88. Configuration

Suggested configuration:

```json
{
  "github": {
    "enabled": true,

    "cache": {
      "enabled": true,
      "softTtlSec": 300,
      "hardTtlSec": 604800
    },

    "search": {
      "defaultLimit": 10,
      "maxLimit": 50
    },

    "runWatch": {
      "fastPollMs": 3000,
      "fastWindowMs": 60000,
      "slowPollMs": 15000,
      "noRunsTimeoutMs": 90000,
      "maxPollFailures": 5,
      "failureGraceMs": 5000,
      "tailLines": 15,
      "maxTailLines": 200
    }
  },

  "git": {
    "worktreeDir": "~/.pi/agent/worktrees",
    "tuiMaxFileBytes": 4194304
  },

  "commit": {
    "analyzeFilesEnabled": true,
    "analyzeFilesMaxFiles": 8,
    "analyzeFilesMaxConcurrency": 4,
    "splitPolicy": "confirm",
    "changelog": true,
    "dryRunAnalyzeFiles": false
  }
}
```

Configuration lives in `~/.pi/agent/pi-omp-git.json` (user) and `.pi/pi-omp-git.json` (project, read only after project trust is granted), layered over the defaults above — the convention used by other packages in this family. Parity-sensitive defaults SHOULD remain fixed unless users override them.

---

# 89. Security model

The extension runs with the same local authority as Pi.

It MUST follow these principles:

### No shell interpolation

Bad:

```ts
exec(`gh pr view ${input}`)
```

Good:

```ts
exec("gh", ["pr", "view", input])
```

### No credential logging

Never include:

```text
GH_TOKEN
GITHUB_TOKEN
Authorization headers
gh hosts.yml secrets
```

in logs.

### Cache isolation

Private GitHub content MUST be keyed by credential fingerprint.

### Read-only URI scheme

`issue://` and `pr://` MUST never mutate GitHub.

### Destructive local Git operations

Discard/reset actions require direct interactive intent.

### Force push

Only `--force-with-lease`, never arbitrary force, through the parity tool.

---

# 90. Error taxonomy

Define stable internal errors:

```ts
class GithubUnavailableError
class GithubAuthError
class GithubRepoResolutionError
class GithubApiError

class InvalidResourceUrlError
class ResourceNotFoundError

class PrCheckoutConflictError
class PrMetadataMissingError
class WorktreeCollisionError

class GitRepositoryError
class GitMutationError
class GitHookError

class ActionsWatchError
class ActionsRateLimitError

class CommitProposalError
class CommitExecutionError
```

Tool-facing messages SHOULD omit stack traces.

Debug logging MAY preserve stacks in a local diagnostic log.

---

# 91. Observability

Optional debug mode:

```text
PI_OMP_GIT_DEBUG=1
```

Log:

```text
operation
duration
cache hit/miss/stale
repo identity
gh command name + sanitized args
git command name + sanitized args
poll counts
worktree path
```

Never log credential values.

---

# 92. Acceptance tests — virtual resources

The release MUST pass tests equivalent to:

```text
read issue://
read issue://123
read issue://owner/repo
read issue://owner/repo/123

read pr://
read pr://123
read pr://owner/repo
read pr://owner/repo/123

read pr://123?comments=0
read pr://123?comments=false

read pr://123/diff
read pr://123/diff/1
read pr://123/diff/all
```

Plus:

```text
invalid diff index
missing repo context
private repo
GitHub Enterprise repo
closed issue
merged PR
PR with review comments but no conversation comments
```

---

# 93. Acceptance tests — diff subsystem

Fixtures MUST cover:

```text
one-file modification
multiple files
new file
deleted file
rename
binary file
very large diff
file whose patch is unavailable
aggregate diff HTTP 406 fallback
```

Assertions:

```text
/diff index ordering stable
/diff/N corresponds to index N
/diff/all contains all available sections
all three views share one cached fetch
```

---

# 94. Acceptance tests — cache

Test:

```text
fresh hit
soft-expired hit
hard-expired row
refresh success
refresh failure
PR diff background refresh
deduplicated simultaneous refresh
different GitHub accounts
different Enterprise hosts
cache disabled
corrupt database
```

Corrupt database behavior:

```text
GitHub still works uncached
```

not:

```text
entire extension crashes
```

---

# 95. Acceptance tests — PR checkout

Test:

```text
same-repo PR
fork PR
HTTPS origin
SSH origin
existing correct pr-N branch
existing wrong pr-N branch
force reset
existing worktree reuse
path collision
batch all-success
batch partial failure
simultaneous checkout calls
```

Verify exact branch config metadata after checkout.

Verify current user's original working tree remains on its original branch and commit.

---

# 96. Acceptance tests — PR push

Test:

```text
current PR branch
non-current PR branch
same-repo PR
fork PR
forceWithLease
missing metadata
remote rejection
```

Verify the pushed ref is exactly:

```text
refs/heads/<PR head ref>
```

and that successful pushes invalidate the PR and PR-diff cache.

---

# 97. Acceptance tests — search

For each search operation test:

```text
default current-repo scope
explicit repo
global qualifier
limit default
limit clamp
relative since
relative until
absolute date
dateField updated
```

Additionally:

```text
search_code + since → reject
search_code + until → reject
search_repos ignores repo
commit search uses committer-date
```

---

# 98. Acceptance tests — Actions

Test:

```text
specific successful run
specific failing run
Actions URL
URL/repo mismatch
commit with one run
commit with several runs
late-arriving run
no runs within timeout
rate limiting
transient API failure
permanent API failure
failed-job log unavailable
AbortSignal cancellation
```

Verify:

```text
first 60 s → 3 s cadence
later → 15 s cadence
failure grace → 5 s
late-run stabilization → one extra poll
```

Time should be injected/faked in tests rather than literally sleeping.

---

# 99. Acceptance tests — Git TUI model

The model layer MUST be testable without a terminal.

Test:

```text
clean repository
only staged
only unstaged
mixed staged + unstaged on same file
untracked
rename
delete
binary
conflict
```

Mutation tests:

```text
stage file
unstage file
discard file
stage hunk
unstage hunk
discard hunk
AI stage subset
```

Verify repository state after each operation using Git commands rather than UI state alone.

---

# 100. Acceptance tests — agentic commit

Required scenarios:

```text
single logical change
two unrelated changes → split
large multi-file change
unstaged-only changes
already-staged changes
untracked files
pre-commit hook rejection
commit-msg hook rejection
signed commit
dry-run
push success
push rejection
model failure
proposal absent
partial split failure
```

Absolute invariant:

```text
No non-dry-run success may be returned unless repository state proves
the intended commit operation actually occurred or there were no changes.
```
The “two unrelated changes → split” scenario asserts structural invariants, not a specific grouping: either one coherent commit covering all changes, or N coherent commits where every changed file lands in exactly one commit and nothing is left uncommitted. Model grouping is not deterministic and MUST NOT be asserted.

---

# 101. Differential parity tests against OMP

For GitHub behavior, build a parity harness.

For a controlled test repository, run equivalent operations through:

```text
OMP
pi + pi-omp-git
```

Normalize volatile fields:

```text
timestamps
temporary paths
cache paths
render spacing
elapsed times
```

Then compare semantic objects.

Do not compare rendered strings only.

Examples:

```ts
normalizeIssue(result)
normalizePr(result)
normalizeDiffIndex(result)
normalizeCheckout(result)
normalizeRunWatch(result)
```

Goal:

```text
same information
same side effects
same safety invariants
```

Pixel-identical TUI rendering is not required.
Timing: the differential harness is deferred until the GitHub surfaces stabilize (v0.2+); v0.1 is validated by the §92–§98 contract tests. The divergence register (§108) records the normalization rules the harness will apply.

---

# 102. Implementation phases

## Phase 1 — GitHub read parity

Implement:

```text
gh runner
repo resolution
read override
issue://
pr://
comments
reviews
PR diff
SQLite cache
```

This delivers the most noticeable OMP GitHub experience.

---

## Phase 2 — GitHub operations

Implement:

```text
repo_view
file_read
five search operations
pr_create
```

---

## Phase 3 — PR worktrees

Implement:

```text
pr_checkout
fork remote resolution
branch metadata
repo mutation lock
pr_push
cache invalidation
```

---

## Phase 4 — Actions

Implement:

```text
run_watch
streaming updates
failed-job logs
artifacts
late-run stabilization
```

---

## Phase 5 — Git TUI

Implement:

```text
/git
status model
file sidebar
split diff
stage/unstage/discard
hunk operations
revision mode
commit editor
```

---

## Phase 6 — AI Git features

Implement:

```text
AI Stage
generated commit message
```

---

## Phase 7 — Agentic commits

Implement:

```text
commit overview
file analysis
single proposal
split proposal
transactional split execution
changelog
dry-run
push
```

---

# 103. Definition of GitHub parity

GitHub parity is achieved when this interaction works naturally:

```text
User:
Look at PR 418, understand the discussion, fix the requested issue,
push it back to the PR, then watch CI.

Agent:

read pr://418

read pr://418/diff

github {
  op: "pr_checkout",
  pr: "418"
}
→ worktreePath: ~/.pi/agent/worktrees/418-a01c72e

... edits and tests using absolute paths under that worktree ...

github {
  op: "pr_push"        // or pr: "418" — defaults to the last checkout
}

github {
  op: "run_watch",
  pr: "418"
}
```
The session cwd is never switched (§110): the agent works from the worktree by absolute path, and later operations resolve their target by parameter or last checkout.

without:

* manually copying PR bodies;
* scraping GitHub HTML;
* altering the user's primary checkout;
* manually discovering fork remotes;
* manually identifying workflow IDs.

---

# 104. Definition of full OMP Git parity

Full parity is achieved when all of the following hold:

### Model-facing

* `issue://` works.
* `pr://` works.
* PR diff resources work.
* GitHub repo files are readable.
* GitHub searches work.
* PR creation works.
* isolated PR checkout works.
* PR push works.
* Actions watching works.
* GitHub Enterprise works.
* private repositories are cache-isolated.

### Interactive

* `/git` opens a real interactive Git UI.
* files can be staged/unstaged/discarded.
* hunks can be staged/unstaged/discarded.
* AI Stage works.
* commit messages can be manually or automatically composed.
* revision inspection works.

### Commit automation

* `/commit` can generate a single commit.
* `/commit` can split unrelated changes.
* hooks are respected.
* changelog support works.
* dry-run is genuinely non-mutating.
* push is optional.
* interrupted or failed split commits do not lose work.
* command success is verified against actual Git repository state.

---

# 105. Recommended implementation priority

If engineering time is constrained, implement in this order:

```text
1. read override + issue:// + pr://
2. PR diff cache
3. pr_checkout + pr_push
4. search
5. run_watch
6. file_read / repo_view / pr_create
7. /git TUI
8. AI Stage
9. agentic /commit
```

Items 1–6 provide nearly all of the improvement an agent actually feels when moving from ordinary Pi toward OMP's GitHub workflow.

The Git TUI and agentic commit command are valuable, but are separable from the core GitHub agent integration.

---

# 106. Suggested first release boundary

A sensible `v0.1.0` should ship:

```text
✓ issue://
✓ pr://
✓ pr://.../diff
✓ caching
✓ GitHub Enterprise
✓ repo_view
✓ file_read
✓ all five searches
✓ pr_create
✓ pr_checkout
✓ pr_push
✓ run_watch
✓ cache invalidation
```

Then:

```text
v0.2 → /git TUI
v0.3 → AI Stage
v0.4 → agentic /commit
```

This avoids blocking the highest-value OMP parity feature—the GitHub interface—on a substantially more complicated full-screen Git client.

---

# 107. Final architectural principle

Do not design this as:

```text
a collection of gh shell shortcuts
```

Design it as:

```text
GitHub resource layer
        +
GitHub operation layer
        +
transaction-safe Git layer
        +
optional interactive Git layer
```

The reason OMP's integration feels materially better than telling an agent to use `gh` is that issues, PRs and diffs become **native readable resources**, while stateful operations such as checkout, push and CI monitoring have explicit semantics.

That separation should be retained in the Pi implementation.

---

# 108. Divergence register

Every place where pi-omp-git deliberately behaves more safely than current OMP is recorded here (ADR 0001). The §101 differential parity harness MUST normalize these divergences rather than treat them as failures.

**D1 — Dry-run never stages.** OMP stages all changes before proposal generation, including when `dryRun` is true. pi-omp-git’s dry-run MUST NOT modify the index or working tree (§74, §82, §104); proposal analysis reads the combined view without staging. Reason: a mutating dry-run is a footgun, and “stage then restore” can lose concurrent or hook-created state.

**D2 — Wrong-SHA PR branch fails unless forced.** OMP reuses an existing worktree for `pr-<number>` without checking whether the branch still matches the PR head. pi-omp-git fails with a clear conflict unless `force` is set (§28). Reason: a silent SHA mismatch between branch and PR head is a correctness hazard.

**D3 — PR URL vs explicit `repo` conflict errors.** OMP silently omits `--repo` when the identifier is a URL. pi-omp-git returns an error rather than risk operating on the wrong repository (§50). Reason: ambiguity about the target repository is worse than a failed call.

**D4 — A 0-for-N batch checkout is an error.** OMP returns a successful result even when every checkout in a batch failed. pi-omp-git returns a tool error when no checkout succeeded; one or more successes produce a successful partial result (§24). Reason: a success result when nothing succeeded misleads the model into continuing a workflow that does not exist.

**D5 — analyzeFiles fan-out is capped.** OMP’s `AnalyzeFiles` fan-out is uncapped. pi-omp-git exposes `analyzeFilesEnabled`, `analyzeFilesMaxFiles`, and `analyzeFilesMaxConcurrency` (§76). Reason: operational control — prevents one expensive model session per file on large diffs.

The §44/§48 log behavior is *not* a divergence: both sides cap capture at 8 MiB. Only the wording differs — this spec says “captured logs,” never “complete logs.”

---

# 109. Authorization model

The extension runs with the same local authority as Pi itself. Pi has no per-tool approval mechanism — it does not ask for approval before every tool call, and the registered-tool contract has no approval property — so OMP’s read/exec approval classification cannot be inherited (ADR 0003).

For v0.1 this means:

* model-initiated `pr_create`, `pr_push`, and forced checkout run with the same authority as every other Pi tool;
* the agent can already run `gh` through ungated `bash`, so gating only this extension’s tools would be inconsistent friction;
* headless and CI use works unmodified.

A future version MAY add an interactive confirmation gate for mutations in TUI mode (`github.confirmMutations`), with non-interactive behavior following configuration. Destructive *local* Git operations remain gated by direct interactive intent (§64, §89).

---

# 110. Post-checkout workflow and operation parameters

Pi exposes the session cwd but has no supported API to switch it live, so after `pr_checkout` the session’s relative file tools still target the user’s original checkout (ADR 0002). The workflow is param/metadata-driven:

1. `pr_checkout` results prominently carry `worktreePath`.
2. The agent edits files via **absolute paths** under the worktree root.
3. `pr_push` and `run_watch` resolve their target as follows:
   * an explicit `pr` (text) or `branch` parameter first;
   * else the session’s **last checkout** — the most recent `pr_checkout` in this session, derived from the session transcript so it survives resume;
   * else current-branch metadata (`pr_push`) or current HEAD (`run_watch`);
   * else an error.
4. `pr_push` and `run_watch` accept a single PR; the array form of `pr` is valid for `pr_checkout` batching alone.

A `/pr <n>` command that opens a nested interactive session in the worktree is a MAY. The SDK’s headless `createAgentSession({ cwd })` cannot host an interactive TUI inside the parent process, so interactive nesting means a child `pi` process.

---

# 111. Managed worktree lifecycle

The parity release ships no lifecycle operations for managed worktrees: they accumulate under the configured worktree root until removed manually:

```bash
git worktree remove <path>
git branch -D pr-<number>
git remote prune <push-remote>
```

A future `pr_worktree_remove` operation is a recorded MAY; its design — handling uncommitted work inside the worktree, pruning `fork-*` remotes — is deliberately deferred until checkout and push are implemented and exercised.
