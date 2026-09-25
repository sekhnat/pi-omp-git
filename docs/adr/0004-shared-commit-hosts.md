# ADR 0004: One commit pipeline and parser, two hosts

- **Status:** Accepted
- **Context:** `pi-omp-git` ships the agent-assisted commit workflow both as
  the Pi `/commit` slash command (inside a Pi session, with UI, session model
  registry, and project-trust-aware configuration) and as the standalone
  `pi-omp-git commit` CLI (no Pi session, user configuration only, its own
  model registry). Two independent implementations would drift: different
  flag semantics, different safety behavior, and double the test surface for
  the most destructive feature in the package.

- **Decision:** There is exactly one commit pipeline and one commit-argument
  parser. `src/git/commit-pipeline.ts` owns planning, proposal validation,
  changelog integration, transactional execution, and push routing; both hosts
  call it with host-specific callbacks (UI confirmation for Pi, none for the
  CLI). `src/git/commit-args.ts` owns the strict option contract (flag set,
  value forms, quoted/trailing context, error rules); both hosts tokenize with
  it, and the CLI adds only its `-C <dir>` option before delegating. Behavior
  differences between hosts are limited to configuration scope, the split-plan
  confirmation seam, and which model registry `--model` resolves against.

- **Consequences:**
  - A safety change to commit scope, staging, or push lands once and applies
    to both hosts; regression tests in `test/commit-args.test.ts` and
    `test/commit-pipeline.test.ts` cover the shared contract directly.
  - The CLI cannot silently diverge (for example by ignoring `--all` or
    accepting unknown flags); the shared parser rejects it.
  - Host-specific behavior stays visible and small: it is confined to the
    adapter layer (`src/index.ts`, `src/cli.ts`), not the pipeline.
