# No extension-level mutation approval gate in v0.1

OMP classifies GitHub reads vs mutations and gates mutations behind approvals. Pi has no approval mechanism at all — its security model states it "does not ask for approval before every tool call," and the registered-tool contract has no approval property — so OMP's approval parity cannot be inherited. We ship v0.1 with no extension-level gate: model-initiated `pr_create`/`pr_push`/forced checkout run with the same authority as every other Pi tool (the agent can already run `gh` through ungated `bash`), and the spec gains an "Authorization model" section stating this explicitly.

## Considered Options

- **Interactive confirmation in TUI, config `github.confirmMutations`, with a non-TTY default** — deferred as a MAY: gating only our own tools while `bash`→`gh` stays ungated is inconsistent friction, and a default-deny would break headless/CI use where the extension is most valuable.
