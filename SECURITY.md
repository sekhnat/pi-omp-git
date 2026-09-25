# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1.0 | No (never published) |

## Reporting a vulnerability

Please report suspected vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/sekhnat/pi-omp-git/security/advisories/new)
for this repository. Do not open a public issue for something you believe is
exploitable.

Include a description, the affected version or commit, steps or a script that
reproduces the issue, and your assessment of impact. You will get an
acknowledgment and can expect coordination on a fix before any public
disclosure. There is currently no paid bounty program.

## Scope

`pi-omp-git` is a local developer tool. It runs `git` and `gh` as
subprocesses, talks to Git remotes and GitHub through them, and stores a local
SQLite cache plus Actions log artifacts on disk.

In scope:

- Credential exposure: tokens or raw authentication output appearing in
  logs, error messages, the doctor report, cache keys, or the database.
- Command injection or unintended execution through repository-controlled
  data (branch names, PR fields, search queries, file paths, run URLs).
- Cache or artifact content leaking across hosts, repositories, or
  credentials beyond the documented fingerprint scoping.
- Path traversal out of the managed worktree root or artifacts directory.
- The feature gate failing closed: GitHub work running while
  `github.enabled` is `false`.

Out of scope:

- Vulnerabilities in `git`, `gh`, Node.js, or Pi itself; report them
  upstream.
- Attacks that already require arbitrary code execution on the developer's
  machine.
- Social engineering of the model provider (prompt injection producing
  unwanted but user-approved actions is tracked as a normal issue, not a
  security vulnerability, unless it bypasses a documented safety gate such
  as proposal validation or mutation confirmation).

## Handling

Fixes land on the main branch and are released as a new patch or minor
version; published npm versions are never overwritten. Security fixes are
called out in the changelog.
