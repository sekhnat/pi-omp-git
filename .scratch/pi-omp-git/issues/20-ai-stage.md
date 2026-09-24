# 20: AI Stage

**What to build:** The Git UI gains AI Stage: the user gives a natural-language instruction ("stage only the changes related to retry handling") and gets a staging plan of matching files and hunks, produced by a nested agent session with read-only Git tools and a staging-plan proposal tool (reusing the machinery from `pr_create fill`). The plan is displayed and **nothing stages until the user confirms it**. Safety is the contract: the index tree and status are snapshotted before application; after application every intended hunk is verified staged and every rejected hunk verified unstaged; a halfway failure restores the snapshot; and the working tree never loses content as a side effect. Binary or inherently indivisible changes are decided at file level. AI staging never commits.

**Blocked by:** 18 (File and hunk operations in the Git TUI), 10 (`pr_create` with nested agent machinery).

**Status:** ready-for-human

- [x] A natural-language instruction yields a plan of selected files/hunks via the nested agent session; unrelated changes remain untouched after application
- [x] The plan is displayed and the user confirms before anything stages; staging never commits
- [x] Index snapshot before; after application, intended hunks are staged and rejected hunks are not; a halfway failure restores the snapshot
- [x] The working tree loses no content as a side effect of AI staging
- [x] Binary or indivisible changes are staged at file level
- [x] Deterministic scripted nested-agent responses drive the tests

## Comments

**Implemented** in src/git/ai-stage.ts plus the TUI wiring: a
natural-language instruction runs a nested agent session (read-only
built-ins + a `propose_stage_plan` proposal tool) over the captured
unstaged diff context and returns a validated plan of files/hunks —
unknown paths and out-of-range hunk indices are rejected; binary
changes must be planned at file level; a run that never proposes fails
clearly. Nothing stages until the displayed plan is confirmed (y in
the TUI); AI staging never commits. Application follows §71: the index
tree is snapshotted with `git write-tree`, hunks apply in descending
index order, then freshly collected Git state must show every intended
hunk staged (unstaged count down exactly one, staged representation
present), every rejected hunk unstaged (counts unchanged), and
unrelated files byte-identical with equal worktree hashes; a halfway
failure or verification mismatch restores the snapshot (`read-tree`,
verified by re-running write-tree) and errors instead of reporting
partial success. The working tree is never touched. Deterministic
scripted nested-agent responses drive the tests
(test/git-ai-stage.test.ts).
