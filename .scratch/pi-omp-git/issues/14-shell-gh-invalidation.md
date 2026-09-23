# 14: Shell `gh` mutation invalidation

**What to build:** When the agent (or the user's interactive `!` command) runs a shell command containing a recognizable `gh` mutation verb — issue close/reopen/edit/comment/delete/lock/unlock/pin/unpin/transfer, PR close/reopen/merge/ready/edit/comment/review/lock/unlock — the relevant cached rows are invalidated **before** the command executes, whether or not it ultimately succeeds (over-invalidation beats staleness). Where host, repository, and number can be identified, invalidation is narrow; when a mutation is detected but the exact target cannot be established, all issue/PR rows for the repository are invalidated. The command string is parsed as a heuristic only — never executed or reinterpreted.

**Blocked by:** 03 (Configuration layering and the SQLite cache).

**Status:** ready-for-agent

- [ ] A `bash` tool result containing a recognized mutation verb invalidates the relevant rows before execution, even when the command fails
- [ ] Interactive `!` commands are observed through the same mechanism
- [ ] Narrow invalidation applies when host/repo/number are identifiable; whole-repository invalidation otherwise
- [ ] Parsing never executes or reinterprets the command string
- [ ] The full verb list from the specification is covered by tests