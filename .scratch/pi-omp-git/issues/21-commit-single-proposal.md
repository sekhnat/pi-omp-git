# 21: `/commit` single proposal with dry-run

**What to build:** `/commit` creates exactly the intended commit from staged changes — one command, verified. The pipeline (overview, relevant diffs, existing commit style) runs in a nested commit-agent session with the narrow tool surface — Git overview, per-file diff, precise hunk retrieval, file-analysis fan-out, and the proposal tools — never a shell. A clean working tree produces a definitive no-changes outcome, never a fake commit; nothing staged with a dirty tree may use reported compatibility staging (never in dry-run). Success means repository state proves it: HEAD moved. `--dry-run` prints the full displayed plan — messages, grouping, changelog plan — while executing no commit, no push, and touching neither index nor working tree. Hooks run normally with stderr preserved on rejection and the failed step identified; signing configuration is respected with no pinentry workarounds and no silent signing downgrade.

**Blocked by:** 10 (`pr_create` with nested agent machinery), 03 (Configuration layering and the SQLite cache).

**Status:** ready-for-human

- [x] `/commit` on staged changes creates the proposed commit, verified by HEAD movement — proposal output alone never means success
- [x] Exactly one of: commits created / failure / definitive no-changes; never "printed a proposal, exited successfully, committed nothing"
- [x] `--dry-run` prints the full plan (messages, grouping, changelog plan) and mutates neither index nor working tree
- [x] Commit hooks run normally; a hook rejection preserves its stderr, identifies the failed step, and errors without stack traces
- [x] GPG signing configuration is respected; unavailable pinentry surfaces Git's real error with no silent retry unsigned
- [x] Compatibility staging (dirty tree, nothing staged) is reported clearly and never happens in dry-run
- [x] The commit agent runs with the narrow tool allowlist and a temporary session directory; the default model is the current session's

## Comments

**Implemented** in src/git/commit-pipeline.ts (+ commit-agent.ts,
commit-plan.ts, commit-execute.ts): the nested commit agent runs with
the narrow §75 tool surface only (git_overview, git_file_diff,
git_hunk, analyze_files, propose_commit, propose_split_commit — never
a shell) in an in-memory session directory. A clean tree yields the
definitive no-changes outcome; nothing staged with a dirty tree stages
all changes and reports compatibility mode clearly — never in dry-run
(D1: the combined view is read without touching the index or working
tree). Success means HEAD moved (§83), verified per commit; a printed
proposal alone is never success. `--dry-run` prints messages,
grouping, and the changelog plan while committing and pushing nothing.
Hooks run normally with stderr preserved and the failed step named
(§84); signing configuration is inherited unchanged (§85). The agent
default model is the current session's model; `--model` resolves
against the session registry.
