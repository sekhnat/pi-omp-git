# 20: AI Stage

**What to build:** The Git UI gains AI Stage: the user gives a natural-language instruction ("stage only the changes related to retry handling") and gets a staging plan of matching files and hunks, produced by a nested agent session with read-only Git tools and a staging-plan proposal tool (reusing the machinery from `pr_create fill`). The plan is displayed and **nothing stages until the user confirms it**. Safety is the contract: the index tree and status are snapshotted before application; after application every intended hunk is verified staged and every rejected hunk verified unstaged; a halfway failure restores the snapshot; and the working tree never loses content as a side effect. Binary or inherently indivisible changes are decided at file level. AI staging never commits.

**Blocked by:** 18 (File and hunk operations in the Git TUI), 10 (`pr_create` with nested agent machinery).

**Status:** ready-for-agent

- [ ] A natural-language instruction yields a plan of selected files/hunks via the nested agent session; unrelated changes remain untouched after application
- [ ] The plan is displayed and the user confirms before anything stages; staging never commits
- [ ] Index snapshot before; after application, intended hunks are staged and rejected hunks are not; a halfway failure restores the snapshot
- [ ] The working tree loses no content as a side effect of AI staging
- [ ] Binary or indivisible changes are staged at file level
- [ ] Deterministic scripted nested-agent responses drive the tests