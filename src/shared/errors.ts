/**
 * Stable, friendly error messages and the error taxonomy base classes.
 * Tool-facing surfaces show `message` only — never stack traces, never
 * echoed tokens (docs/pi-omp-git-reference.md §49, §90).
 *
 * GitHub taxonomy correspondence (§90): DependencyError ≙
 * GithubUnavailableError, AuthenticationError ≙ GithubAuthError,
 * NoRepositoryContextError ≙ GithubRepoResolutionError, GithubApiError.
 */

export const FRIENDLY_ERRORS = {
	ghMissing: "GitHub CLI (gh) is not installed.",
	ghUnauthenticated: "GitHub CLI is not authenticated. Run `gh auth login`.",
	gitMissing: "Git is not installed.",
	noRepoContext:
		"GitHub repository context is unavailable. Pass `repo` explicitly or run inside a GitHub checkout.",
	invalidJson: "GitHub CLI returned invalid JSON.",
} as const;

export class PiOmpGitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** A required external binary is missing (gh, git). */
export class DependencyError extends PiOmpGitError {
	readonly binary: "git" | "gh";

	constructor(message: string, binary: "git" | "gh") {
		super(message);
		this.binary = binary;
	}
}

/** The external binary exists but is not authenticated. */
export class AuthenticationError extends PiOmpGitError {
	constructor(message: string = FRIENDLY_ERRORS.ghUnauthenticated) {
		super(message);
	}
}

/** The operation needs a GitHub repository context none was resolvable. */
export class NoRepositoryContextError extends PiOmpGitError {
	constructor(message: string = FRIENDLY_ERRORS.noRepoContext) {
		super(message);
	}
}

/** A resolved resource (issue, PR, file) does not exist on the host. */
export class ResourceNotFoundError extends PiOmpGitError {}

/** `gh` produced output that is not parseable JSON. */
export class InvalidJsonError extends PiOmpGitError {
	constructor(message: string = FRIENDLY_ERRORS.invalidJson) {
		super(message);
	}
}

/** A GitHub API request failed (HTTP error, rate limit, malformed response). */
export class GithubApiError extends PiOmpGitError {}

/** Map an availability probe failure into the thrown form GitHub surfaces use. */

/** A local `pr-N` branch exists at a SHA other than the PR head (divergence D2). */
export class PrCheckoutConflictError extends PiOmpGitError {}

/** A branch carries no PR checkout metadata, so `pr_push` cannot act on it. */
export class PrMetadataMissingError extends PiOmpGitError {}

/** No worktree path could be allocated after the bounded suffix search. */
export class WorktreeCollisionError extends PiOmpGitError {}

/** A Git repository-level operation failed (resolution, worktree, refs). */
export class GitRepositoryError extends PiOmpGitError {}

/** A mutating Git operation (branch, push, reset) failed. */
export class GitMutationError extends PiOmpGitError {}

/** A Git hook rejected the operation; its stderr is preserved. */
export class GitHookError extends PiOmpGitError {}

/** An Actions watch failed — polling exhausted its failure budget. */
export class ActionsWatchError extends PiOmpGitError {}

/** Actions API rate limiting exhausted the poll-failure budget. */
export class ActionsRateLimitError extends PiOmpGitError {}
export class CommitProposalError extends PiOmpGitError {}
export class CommitExecutionError extends PiOmpGitError {}
export function ensureAvailable(
	status:
		| { ok: true }
		| { ok: false; reason: "missing" | "unauthenticated"; message: string },
	binary: "git" | "gh",
): void {
	if (status.ok) return;
	if (status.reason === "unauthenticated") {
		throw new AuthenticationError(status.message);
	}
	throw new DependencyError(status.message, binary);
}
