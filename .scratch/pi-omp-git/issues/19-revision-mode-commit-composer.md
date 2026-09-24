# 19: Revision mode and commit composer

**What to build:** The `/git` UI gains two capabilities. Revision inspection mode (launched with a revision argument) resolves the commit or ref, lists its changed files, shows parent-versus-revision diffs, and disables all working-tree mutation commands — read-only. Large-file and binary handling lands with it: ordinary diffable files over 4 MiB show status instead of content, binary files show status without decoding, image changes may preview where the terminal supports it (SVG rasterization resource-limited), and Git LFS pointers are recognized so pointer text is never misrepresented as content. The commit composer completes the loop: manual commit messages, AI-generated Conventional Commits messages that the user can edit before execution, and amend mode.

**Blocked by:** 18 (File and hunk operations in the Git TUI).

**Status:** ready-for-human

- [x] Revision mode resolves the revision, lists changed files, shows parent-vs-revision diffs, and disables stage/unstage/discard
- [x] Ordinary diffable files over 4 MiB show status instead of content; metadata and change status stay visible
- [x] Binary files show status without decoding; LFS pointers are recognized; image previews optional; SVG rasterization resource-limited
- [x] The composer supports manual messages, editable AI-generated Conventional Commits messages, and amend mode

## Comments

**Implemented**: revision mode (`/git <revision>` and
`pi-omp-git git <revision>`) resolves the commit via rev-parse (root
commits diff against the empty tree via `diff-tree --root`), lists
changed files from `diff-tree --name-status` (M/A/D/T), and shows
parent-versus-revision diffs; all working-tree mutations, area
switching, and the composer are refused with a read-only message, and
the layout switches to a single "Changes in <ref>" section with a
read-only action bar. Files over the 4 MiB §68 limit show the
too-large status from blob sizes before any content loads; binary
files show status without decoding; Git LFS pointers are recognized
from blob content (§69); image previews remain an unimplemented MAY.
The composer (c) supports manual messages, editable AI-generated
Conventional Commits messages from a nested agent session (staged
patch + recent commit style), and amend mode; execution writes the
message with `commit -F`, runs hooks normally, preserves hook stderr
with the failed step named, respects signing configuration, and is
proven by HEAD movement (§83). Tests: test/git-revision-composer.test.ts.
