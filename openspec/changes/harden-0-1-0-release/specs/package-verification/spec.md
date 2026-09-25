# Spec Delta

## Purpose

Ensure the published 0.1.0 package works outside the source checkout and is released only after repeatable verification.

## ADDED Requirements

### Requirement: Installable Pi package contract
Every directly imported Pi host runtime package SHALL be declared as a peer using Pi's package convention, including `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, and the actually imported `typebox`. Local development SHALL have reproducible dependencies without shipping a competing host runtime. The published tarball SHALL contain resolvable Pi extension and CLI entrypoints plus required documentation and metadata (repository, bugs, homepage, and MIT license).

#### Scenario: Runtime peer audit
- **WHEN** the package's direct host imports are compared against its manifest
- **THEN** each imported host package is declared as a peer and no imported host package depends solely on transitive installation

#### Scenario: Install outside source tree
- **WHEN** the tarball is installed in a clean fixture with the supported peer runtime
- **THEN** its declared Pi extension entrypoint loads and the companion CLI starts without resolving undeclared source-checkout dependencies

#### Scenario: Published content
- **WHEN** the npm tarball is inspected
- **THEN** all declared entrypoints and required license/readme/release content are present

### Requirement: Canonical quality gate and release validation
The repository SHALL provide `npm run check` covering type checking, Biome validation, and Vitest tests. Push and pull-request CI SHALL invoke this command on Node 22 with Git available. A package smoke command SHALL pack and inspect/install the tarball in an isolated fixture and verify entrypoints and runtime declarations. Any documented or automated 0.1.0 release process SHALL require passing checks, passing smoke validation, tag/version agreement, and inspecting the tarball before npm publication; failed gates SHALL prevent publication.

#### Scenario: CI on a pull request
- **WHEN** a pull request triggers CI
- **THEN** the canonical check suite runs and a failure blocks the required verification job

#### Scenario: Packed package regression
- **WHEN** a published file or runtime peer declaration is omitted
- **THEN** the packed-package smoke check fails even if source-checkout tests pass

#### Scenario: Version mismatch at release
- **WHEN** a proposed release tag does not match `package.json` version
- **THEN** the release process fails before publication

#### Scenario: Failed release check
- **WHEN** check, smoke, or tarball inspection fails
- **THEN** the package is not published by the release process
