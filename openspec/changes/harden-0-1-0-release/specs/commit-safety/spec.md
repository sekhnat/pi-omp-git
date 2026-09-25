# Spec Delta

## Purpose

Make the scope of agent-assisted commits explicit so unrelated working-tree changes are not silently staged or committed.

## ADDED Requirements

### Requirement: Staged-only default commit scope
Without `--all`, agent-assisted commit SHALL operate on the staged set only. If there are no staged changes but the tree is dirty, it SHALL return an actionable no-staged-changes outcome without staging, committing, or pushing; if the tree is clean it SHALL retain the deterministic no-changes result (and existing explicit clean-tree push behavior). Existing explicitly enabled changelog integration MAY update its identified changelog within an otherwise valid staged commit, as documented.

#### Scenario: Staged changes coexist with unstaged work
- **WHEN** staged and unrelated unstaged changes exist and the user runs commit without `--all`
- **THEN** only the intended staged changes are committed and unrelated changes remain unstaged

#### Scenario: Tracked work is only unstaged
- **WHEN** only unstaged tracked modifications exist and the user runs commit without `--all`
- **THEN** no staging or commit occurs and the result explains how to stage files or use `--all`

#### Scenario: Only untracked files
- **WHEN** only untracked files exist and the user runs commit without `--all`
- **THEN** no staging or commit occurs and the result explains how to opt into staging

#### Scenario: Clean tree
- **WHEN** the tree is clean and the user runs commit without `--push`
- **THEN** the command reports a definitive no-changes outcome without creating a commit

### Requirement: Explicit all-changes staging
Both commit hosts SHALL accept `--all` as explicit consent to stage and commit the intended repository-wide tracked modifications, deletions, and untracked files, whether or not some files were already staged. Without `--all`, there SHALL be no automatic whole-tree staging. Proposal validation and post-mutation repository verification SHALL remain effective.

#### Scenario: Mixed staged and unstaged with all
- **WHEN** staged and unstaged changes exist and `--all` is supplied
- **THEN** the planned change set includes the explicitly requested changes, subject to proposal validation

#### Scenario: Deletion and untracked file with all
- **WHEN** a tracked file is deleted and a new untracked file exists and `--all` is supplied
- **THEN** both can be staged and committed after a valid plan

#### Scenario: Invalid proposal
- **WHEN** the proposal is missing or fails validation, including for an `--all` invocation
- **THEN** no commit is created and the caller's index and working-tree contents are not unexpectedly changed

### Requirement: Non-mutating preview
A dry run SHALL never stage files, replace the caller's index, edit the changelog, create a commit, or push. Dry-run with `--all` SHALL describe the requested all-changes scope without performing the mutation; dry-run without `--all` SHALL follow staged-only scope and report no staged changes when applicable.

#### Scenario: Preview all from dirty tree
- **WHEN** a dirty tree is previewed with `--dry-run --all`
- **THEN** the plan includes intended tracked and untracked changes while HEAD, index, and working-tree contents remain unchanged

#### Scenario: Preview without all
- **WHEN** only unstaged changes exist and `--dry-run` is supplied without `--all`
- **THEN** no index mutation or commit occurs and the caller receives the no-staged-changes guidance
