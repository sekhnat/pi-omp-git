/**
 * PR identifier parsing — the `pr` parameter forms accepted by
 * `pr_checkout` and `pr_push` (docs/pi-omp-git-reference.md §24):
 *
 *   "418"                                  → number as text
 *   "https://github.com/owner/repo/pull/418" → PR URL
 *   anything else                           → branch-like identifier
 *
 * JSON numbers are rejected at the dispatcher boundary, never here —
 * this module only ever sees text.
 */

import { PiOmpGitError } from "../shared/errors.ts";

export type PrIdentifier =
	| { kind: "number"; number: number; text: string }
	| {
			kind: "url";
			url: string;
			host: string;
			owner: string;
			repo: string;
			number: number;
	  }
	| { kind: "branch"; ref: string };

const PR_URL_PATTERN =
	/^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/**
 * Parse one PR identifier. Returns null for empty text and for URLs that
 * do not point at a pull request — both are caller errors.
 */
export function parsePrIdentifier(text: string): PrIdentifier | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	if (/^\d+$/.test(trimmed)) {
		return { kind: "number", number: Number(trimmed), text: trimmed };
	}

	const url = PR_URL_PATTERN.exec(trimmed);
	if (url) {
		return {
			kind: "url",
			url: trimmed,
			host: url[1]?.toLowerCase() ?? "",
			owner: url[2] ?? "",
			repo: url[3] ?? "",
			number: Number(url[4]),
		};
	}

	if (/^https?:\/\//i.test(trimmed)) {
		// A URL that is not a PR URL is never accepted as a branch name.
		return null;
	}

	return { kind: "branch", ref: trimmed };
}

/**
 * Divergence D3 (§108): a PR URL names its repository exactly; combining
 * it with a conflicting explicit `repo` is refused rather than silently
 * dropping the flag.
 */
export function checkPrUrlRepoConflict(
	parsed: PrIdentifier,
	explicitRepo: string | undefined,
): void {
	if (parsed.kind !== "url" || !explicitRepo) return;
	const segments = explicitRepo.trim().split("/").filter(Boolean);
	if (segments.length < 2) return;
	const owner = segments[segments.length - 2]?.toLowerCase();
	const repo = segments[segments.length - 1]?.toLowerCase();
	const host = segments.length === 3 ? segments[0]?.toLowerCase() : undefined;
	if (
		parsed.owner.toLowerCase() === owner &&
		parsed.repo.toLowerCase() === repo
	) {
		if (host === undefined || host === parsed.host) return;
	}
	throw new PiOmpGitError(
		`The \`pr\` URL points at ${parsed.host}/${parsed.owner}/${parsed.repo}, ` +
			`but \`repo\` says ${explicitRepo}. Refusing the ambiguous target — ` +
			"pass the matching repository or omit `repo`",
	);
}
