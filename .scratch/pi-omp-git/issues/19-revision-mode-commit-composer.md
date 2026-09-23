# 19: Revision mode and commit composer

**What to build:** The `/git` UI gains two capabilities. Revision inspection mode (launched with a revision argument) resolves the commit or ref, lists its changed files, shows parent-versus-revision diffs, and disables all working-tree mutation commands — read-only. Large-file and binary handling lands with it: ordinary diffable files over 4 MiB show status instead of content, binary files show status without decoding, image changes may preview where the terminal supports it (SVG rasterization resource-limited), and Git LFS pointers are recognized so pointer text is never misrepresented as content. The commit composer completes the loop: manual commit messages, AI-generated Conventional Commits messages that the user can edit before execution, and amend mode.

**Blocked by:** 18 (File and hunk operations in the Git TUI).

**Status:** ready-for-agent

- [ ] Revision mode resolves the revision, lists changed files, shows parent-vs-revision diffs, and disables stage/unstage/discard
- [ ] Ordinary diffable files over 4 MiB show status instead of content; metadata and change status stay visible
- [ ] Binary files show status without decoding; LFS pointers are recognized; image previews optional; SVG rasterization resource-limited
- [ ] The composer supports manual messages, editable AI-generated Conventional Commits messages, and amend mode