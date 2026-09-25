# Spec Delta

## Purpose

Make a git-source install deliver both the Pi extension and a runnable companion CLI, with safe build behavior on every install path.

## ADDED Requirements

### Requirement: Git install provides the CLI
Installing the package from a git source SHALL leave the companion CLI runnable from the installed location without a manual build step: a CLI launcher invoked from the installed tree SHALL execute the implementation even when no compiled `dist` output exists in that tree.

#### Scenario: Pi-installed clone runs the CLI without a build
- **WHEN** the package is installed from its git source into Pi's managed install directory and the launcher is invoked with Node 22.19+
- **THEN** the CLI runs successfully even though the installed tree contains no `dist` directory

#### Scenario: Source checkout runs the CLI without a build
- **WHEN** the CLI launcher is invoked from a repository checkout after only dependency installation
- **THEN** the CLI runs successfully

### Requirement: Launcher prefers compiled output under Node module constraints
The CLI launcher SHALL execute compiled output when present, because importing TypeScript sources is rejected inside `node_modules`. If compiled output is present but fails to start, the launcher SHALL report the failure rather than silently falling back to sources.

#### Scenario: Installed from a packed tarball
- **WHEN** the package was installed from a packed tarball with prebuilt `dist` output and the launcher is invoked
- **THEN** the compiled output runs; sources are not imported

#### Scenario: Compiled output fails to start
- **WHEN** compiled output exists but fails to load
- **THEN** the launch fails with the loader's error rather than a silent fallback

### Requirement: Prepare is safe on every install path
The package `prepare` script SHALL NOT fail an install that does not provide development dependencies, and SHALL produce compiled output when they are available.

#### Scenario: Pi installs the git source
- **WHEN** Pi installs the package from a git source with development dependencies omitted
- **THEN** the install succeeds and no build is attempted

#### Scenario: npm installs from a git URL
- **WHEN** npm installs the package as a git dependency (development dependencies installed before `prepare`)
- **THEN** compiled output is produced and the global CLI launcher works

#### Scenario: Build failure is not swallowed
- **WHEN** the build tool is available and the build fails during `prepare`
- **THEN** the install fails with the build error

### Requirement: Host packages resolve outside the installed tree
When the installed tree does not contain the host packages, the CLI launcher SHALL resolve them from the user's Pi installation rather than failing, and SHALL fail with an error naming the missing package when neither source provides them.

#### Scenario: Bare installed tree with Pi available
- **WHEN** the launcher falls back to TypeScript sources in a tree that has no `node_modules` and a Pi installation is discoverable on the machine
- **THEN** the CLI runs, resolving its host package imports from the Pi installation

#### Scenario: No host packages anywhere
- **WHEN** neither the installed tree nor a discoverable Pi installation provides a host package the CLI imports
- **THEN** the launch fails with an error naming that package
### Requirement: Documented PATH setup for git installs
The README SHALL state which install methods provide the extension and/or the CLI, how to make the git-installed CLI available on `PATH`, and that checkouts with compiled output must rebuild after pulling source changes to avoid running stale output.

#### Scenario: A user follows the README install matrix
- **WHEN** a user reads the installation section after installing via a git source
- **THEN** the README states whether the CLI was installed, gives a concrete `PATH` setup (alias or symlink), and warns about stale compiled output in checkouts
