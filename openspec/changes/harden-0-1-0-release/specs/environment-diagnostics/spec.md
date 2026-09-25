# Spec Delta

## Purpose

Give users enough safe, actionable information to troubleshoot local Git, optional GitHub integration, configuration, and package installation.

## ADDED Requirements

### Requirement: Actionable redacted doctor report
`/omp-git-doctor` SHALL report Node and package versions, Pi/runtime version when available, Git and GitHub CLI versions/availability, token-free GitHub authentication state when enabled, GitHub enabled/disabled state, resolved Pi agent directory, discovered configuration paths and active layers, worktree root, cache path/access status, and relevant repository root/current directory. Each check SHALL distinguish OK, intentionally disabled, optional unavailable, and actionable error as appropriate. The report SHALL NOT print tokens, authorization headers, credential-helper output, secrets, or environment dumps. The CLI SHALL offer equivalent diagnostics when it can load the same diagnostic model without requiring a Pi session.

#### Scenario: Disabled GitHub
- **WHEN** the resolved setting is `github.enabled=false`
- **THEN** doctor reports intentionally disabled GitHub integration without requiring an authenticated `gh` session

#### Scenario: Missing optional gh
- **WHEN** Git is available but `gh` is missing and GitHub integration is enabled
- **THEN** doctor reports Git OK, `gh` unavailable but optional for Git-only work, and an actionable GitHub setup hint

#### Scenario: Custom agent directory and trust
- **WHEN** Pi resolves a custom agent directory and a project file is present but untrusted
- **THEN** doctor reports the resolved directory and discovered project file but does not describe that file as an active layer

#### Scenario: Credentials present
- **WHEN** `gh` authentication or credential environment values exist
- **THEN** doctor reports only a redacted status and no token or credential value

#### Scenario: Cache not writable
- **WHEN** the configured cache location cannot be written
- **THEN** doctor reports an actionable cache access problem rather than claiming it is healthy
