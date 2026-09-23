# The commit pipeline runs in nested headless agent sessions

OMP's agentic commit pipeline and its AnalyzeFiles fan-out run inside OMP's own harness. In Pi, the `/commit` pipeline runs as a nested session created with the SDK's `createAgentSession({ cwd, noTools: "all" })` — a headless model session whose only tools are the narrowly scoped commit tools (`git_overview`, `git_file_diff`, `git_hunk`, `analyze_files`, `propose_commit`, `propose_split_commit`), never `bash`. One pipeline implementation serves two hosts: the `/commit` slash command runs it in-process; the `pi-omp-git commit` companion binary runs it standalone. The default model is the current session's model unless `--model` is given.

## Considered Options

- **Drive the pipeline through the user's session via prompt injection** — rejected: it pollutes the user's transcript with commit-analysis turns and cannot enforce the narrow tool surface §75 requires.
- **Companion-binary-only** — rejected: loses the in-Pi `/commit` experience the spec requires.

## Consequences

- Nested agent sessions write to a temporary session directory and do not appear in the user's session list.
- The same machinery is the designated home for every model-assisted feature outside the user's turn (AI Stage, `pr_create`'s `fill`), keeping one nested-agent implementation.
