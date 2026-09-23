/**
 * Model-facing tool guidelines for the GitHub surfaces, appended through
 * Pi's system-prompt build hook (`before_agent_start` →
 * `systemPromptOptions.promptGuidelines`) — never by rewriting the prompt
 * (docs/pi-omp-git-reference.md §59).
 */

export const GITHUB_PROMPT_GUIDELINES = [
	"- Read GitHub issues and PRs through issue:// and pr:// resources.",
	"- Use pr://N/diff for the changed-file index, pr://N/diff/I for one file, and pr://N/diff/all only when the complete diff is required.",
	"- Use GitHub file_read instead of curl/wget for files stored in GitHub repos.",
	"- Use GitHub search operations rather than scraping GitHub search pages.",
	"- Use pr_checkout to inspect or modify PRs; it creates isolated worktrees.",
	"- Use pr_push for branches created by pr_checkout.",
	"- After pr_checkout, edit files using absolute paths under the returned worktreePath; pr_push and run_watch default to the session's last checkout.",
	"- Use run_watch to monitor GitHub Actions.",
] as const;
