# 21: `/commit` single proposal with dry-run

**What to build:** `/commit` creates exactly the intended commit from staged changes — one command, verified. The pipeline (overview, relevant diffs, existing commit style) runs in a nested commit-agent session with the narrow tool surface — Git overview, per-file diff, precise hunk retrieval, file-analysis fan-out, and the proposal tools — never a shell. A clean working tree produces a definitive no-changes outcome, never a fake commit; nothing staged with a dirty tree may use reported compatibility staging (never in dry-run). Success means repository state proves it: HEAD moved. `--dry-run` prints the full displayed plan — messages, grouping, changelog plan — while executing no commit, no push, and touching neither index nor working tree. Hooks run normally with stderr preserved on rejection and the failed step identified; signing configuration is respected with no pinentry workarounds and no silent signing downgrade.

**Blocked by:** 10 (`pr_create` with nested agent machinery), 03 (Configuration layering and the SQLite cache).

**Status:** ready-for-agent

- [ ] `/commit` on staged changes creates the proposed commit, verified by HEAD movement — proposal output alone never means success
- [ ] Exactly one of: commits created / failure / definitive no-changes; never "printed a proposal, exited successfully, committed nothing"
- [ ] `--dry-run` prints the full plan (messages, grouping, changelog plan) and mutates neither index nor working tree
- [ ] Commit hooks run normally; a hook rejection preserves its stderr, identifies the failed step, and errors without stack traces
- [ ] GPG signing configuration is respected; unavailable pinentry surfaces Git's real error with no silent retry unsigned
- [ ] Compatibility staging (dirty tree, nothing staged) is reported clearly and never happens in dry-run
- [ ] The commit agent runs with the narrow tool allowlist and a temporary session directory; the default model is the current session's