/**
 * Stable, friendly error messages and the error taxonomy base classes.
 * Tool-facing surfaces show `message` only — never stack traces, never
 * echoed tokens (docs/pi-omp-git-reference.md §49).
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
	constructor(
		message: string,
		public readonly binary: "git" | "gh",
	) {
		super(message);
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

/** Map an availability probe failure into the thrown form GitHub surfaces use. */
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
