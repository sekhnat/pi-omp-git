# Spec Delta

## Purpose

Make configuration and Pi-owned storage paths predictable across the extension and companion CLI without trusting unapproved project files.

## ADDED Requirements

### Requirement: Trust-aware configuration precedence
The system SHALL resolve supported settings in the order defaults < user config < trusted project config < supported environment/runtime overrides. A project file SHALL participate only when the host considers that project trusted; the standalone CLI SHALL NOT assume trust merely because a file exists. Invalid or unreadable values SHALL follow the documented nonfatal validation/fallback behavior, without changing which valid layer has precedence.

#### Scenario: User setting only
- **WHEN** the user file sets `commit.splitPolicy` to `auto` and no trusted project or override sets it
- **THEN** the resolved value is `auto`

#### Scenario: Trusted project takes precedence
- **WHEN** the user file sets `commit.splitPolicy` to `auto` and a trusted project file sets it to `never`
- **THEN** the resolved value is `never`

#### Scenario: Untrusted project is ignored
- **WHEN** a project file sets `commit.splitPolicy` to `never` but the project is not trusted and the user file sets it to `auto`
- **THEN** the resolved value is `auto` and the project file is not applied

#### Scenario: Supported environment override wins
- **WHEN** a trusted project sets `worktree.root` and `PI_OMP_GIT_WORKTREE_DIR` is set
- **THEN** the resolved worktree root is the environment override

#### Scenario: Invalid higher layer
- **WHEN** a trusted project file supplies an invalid value for a setting with a valid user value
- **THEN** the documented validation/fallback behavior applies and the invalid value is not treated as authoritative

### Requirement: Pi-resolved agent directory
The system SHALL derive Pi-owned user configuration, default cache, default worktree, artifact, and CLI TUI paths from Pi's resolved agent directory, including when `PI_CODING_AGENT_DIR` is configured. Explicit supported path overrides SHALL retain their documented precedence.

#### Scenario: Custom Pi directory
- **WHEN** Pi resolves a nondefault agent directory and there are no explicit path overrides
- **THEN** the extension and CLI use that directory for all applicable Pi-owned state rather than `~/.pi/agent`

#### Scenario: Explicit path override
- **WHEN** the resolved agent directory is custom and a supported cache or worktree path override is supplied
- **THEN** that path wins for its own setting while other Pi-owned defaults stay under the resolved agent directory
