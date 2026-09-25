# Spec Delta

## Purpose

Let users turn off GitHub integration completely while retaining local Git functionality and clear explanations of disabled surfaces.

## ADDED Requirements

### Requirement: Effective GitHub feature gate
When resolved `github.enabled` is `false`, the extension SHALL NOT execute GitHub CLI requests, GitHub mutation operations, GitHub resource reads, GitHub-specific shell invalidation, or unnecessary GitHub cache/background activity. It SHALL NOT advertise GitHub capabilities as active; any still-registered GitHub-facing surface SHALL return a specific disabled result rather than invoking `gh`. The effective gate SHALL be honored after trust and configuration resolution, including when settings are reloaded.

#### Scenario: Disabled tool operation
- **WHEN** `github.enabled=false` and a caller invokes an existing GitHub operation, including a mutation
- **THEN** no GitHub command or mutation runs and the caller receives a clear integration-disabled outcome

#### Scenario: Disabled virtual resource
- **WHEN** `github.enabled=false` and a caller reads `issue://` or `pr://`
- **THEN** no GitHub fetch or cache initialization occurs and the caller receives a clear disabled result

#### Scenario: Git-only functionality remains
- **WHEN** `github.enabled=false` and the caller opens `/git` or runs a local commit without GitHub-dependent push behavior
- **THEN** the Git-only workflow remains available

#### Scenario: Disabled background hooks and guidance
- **WHEN** `github.enabled=false` during an extension session
- **THEN** GitHub mutation observers and GitHub-specific model guidance do not advertise or perform enabled integration work

#### Scenario: Enabled compatibility
- **WHEN** `github.enabled=true`
- **THEN** existing GitHub operation names, input forms, cache behavior, and results remain available
