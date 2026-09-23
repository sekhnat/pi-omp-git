# Safer-by-default, recorded in a divergence register

The spec's top priority is "behavioral compatibility with OMP," yet several requirements specify behavior stronger than current OMP (wrong-SHA `pr-N` branches fail instead of being silently reused; PR-URL vs explicit `repo` conflicts error instead of silently dropping `--repo`; dry-run never stages although OMP stages even in dry-run; a 0-for-N batch checkout errors although OMP reports success). We keep the safer behaviors and record each one in an explicit divergence register in the spec, so the §101 differential parity harness normalizes known divergences instead of failing on them.

## Considered Options

- **Bug-for-bug OMP parity** — rejected: it enshrines OMP footguns the spec was written to avoid, and the spec's own priority list already ranks non-destructive Git operations alongside compatibility.
- **Ad hoc per-case decisions, no register** — rejected: it leaves the parity-vs-safety contradiction standing in five places with no way for the parity harness to know which differences are intentional.
