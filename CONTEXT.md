# pi-omp-git

An upstream Pi package that reproduces Oh My Pi's Git and GitHub capabilities — read-only GitHub resources, agent operations, an interactive Git UI, and an agentic commit pipeline — with deliberate, recorded safety divergences from OMP.

## Language

**Read-only resource**:
A GitHub issue, PR, or PR diff exposed through the `issue://` or `pr://` URI schemes: agents can read it but never mutate it through the scheme, while its server-side content may change and its cached representation may refresh.
_Avoid_: immutable, virtual file

**Divergence**:
A place where pi-omp-git deliberately behaves more safely than current OMP; each is recorded in the spec's divergence register with OMP's behavior, ours, and the reason.
_Avoid_: deviation, incompatibility, regression

**Rendered snapshot**:
The complete text rendering of a read-only resource at one cache-row version; paginated reads slice the snapshot rather than re-resolving the resource.
_Avoid_: cached file, rendered file

**Dry-run**:
A commit-pipeline execution that performs full analysis and prints the plan but must not modify the index or the working tree.
_Avoid_: preview, trial run

**Partial success**:
The outcome of a batch operation in which at least one unit succeeded; reported as tool success together with structured per-unit failures.
_Avoid_: best-effort, soft failure

**Managed worktree**:
A dedicated Git worktree that `pr_checkout` creates under the configured worktree root to hold one PR's local branch, leaving the user's primary checkout untouched.
_Avoid_: checkout directory, PR clone

**PR branch**:
The local branch `pr-<number>` that carries a PR's checkout and push metadata.
_Avoid_: contributor branch (that is the remote PR head ref)

**Commit agent**:
The nested headless model session that analyzes changes and proposes commits or staging plans; it sees only narrowly scoped Git-read and proposal tools, never a shell.
_Avoid_: commit subagent, commit model

**Last checkout**:
The most recent `pr_checkout` performed in the current session; the default resolution target for `pr_push` and `run_watch` when no explicit parameter is given.
_Avoid_: current PR, active PR

**Nested agent session**:
A headless model session the extension creates to run model-assisted work outside the user's turn — the commit agent, AI Stage, and `pr_create` fill; it never joins the user's transcript and never gets a shell.
_Avoid_: subagent (reserved for operator-requested delegation), background session
