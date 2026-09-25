# Spec Delta

## Purpose

Expose a single predictable argument contract for agent-assisted commit commands in Pi and the companion CLI.

## ADDED Requirements

### Requirement: Equivalent commit options across hosts
Pi `/commit` and `pi-omp-git commit` SHALL interpret the same logical commit options equivalently: `--all`, `--push`, `--dry-run`, `--no-changelog`, `--model <value>` / `--model=<value>`, and `--context <value>` / `--context=<value>`. Host-only `-C <dir>` SHALL remain available in the CLI without changing commit option semantics. Model lookup and user-interface presentation remain host-specific.

#### Scenario: Multiple flags
- **WHEN** each host receives the logical arguments `--all --dry-run --model provider/model-id --context "release notes"`
- **THEN** both resolve equivalent options, including the multiword context

#### Scenario: Host-specific directory
- **WHEN** the companion CLI receives `commit -C /path/to/repo --all`
- **THEN** it selects that repository and interprets `--all` the same way as Pi

### Requirement: Strict argument validation
Both hosts SHALL reject unknown flags, missing or empty values for value-taking options, flag-shaped values accidentally supplied as option values, and unexpected bare positional arguments with equivalent validation errors. Both SHALL preserve quoted/free-form context where their host interface permits it. A `--` delimiter SHALL allow trailing free-form context without treating its words as flags; an explicit `--context` value SHALL NOT be silently overwritten by trailing context.

#### Scenario: Unknown flag
- **WHEN** either host receives `--unknown`
- **THEN** parsing fails before the commit pipeline runs and reports the unknown option

#### Scenario: Missing value
- **WHEN** either host receives `--model` with no value or `--context --push`
- **THEN** parsing fails before any repository mutation

#### Scenario: Empty model
- **WHEN** either host receives `--model=` or an empty model argument
- **THEN** parsing reports an invalid model value before invoking model lookup

#### Scenario: Free-form delimiter
- **WHEN** either host receives `-- release notes for 0.1.0`
- **THEN** it interprets the remaining words as commit context rather than options
