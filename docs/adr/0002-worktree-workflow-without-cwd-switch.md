# Post-checkout workflow is param/metadata-driven, not cwd-switched

Pi exposes the session cwd but has no supported API to change it live (`ExtensionCommandContext.newSession()` creates a new session file with no cwd option, and the process cwd is fixed at startup). After `pr_checkout` returns a worktree path, relative file tools, `pr_push`'s "current branch," and `run_watch` commit-mode HEAD would all still resolve against the user's original checkout. We therefore make the workflow param/metadata-driven: `pr_checkout` results prominently carry `worktreePath`, the agent edits via absolute paths under it, and `pr_push`/`run_watch` accept explicit `pr`/`branch`/`commit` parameters with a defined default-resolution order.

## Consequences

- §103's flagship example must be rewritten to show the real interaction (absolute paths, explicit or defaulted operation parameters).
- §59's prompt guidance tells the agent to use absolute worktree paths.
- A `/pr <n>` command that opens a nested interactive session in the worktree remains a MAY; the SDK's headless `createAgentSession({ cwd })` is available but does not give an interactive TUI in the parent.
