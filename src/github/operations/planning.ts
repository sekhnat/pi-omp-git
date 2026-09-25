/**
 * Pure input/ref/target planning for the GitHub operations — the side-effect
 * separation boundary described in the change design. Everything here is
 * deterministic and I/O-free: no `gh` or Git calls, no filesystem access, no
 * clock. The operation adapters (`pr-checkout.ts`, `run-watch.ts`) consume
 * these plans and keep every actual read/write with their existing adapters.
 *
 * Extracted decision groups:
 * - PR checkout: batch identifier normalization, base-identity resolution
 *   from the identifier or an explicit `repo`, and the payload→target plan
 *   (branch name, head ref, pull URL, cross-repository decision, fetch
 *   source).
 * - Actions watching: run/commit mode selection, run identifier parsing with
 *   URL/repo conflict checks, repository identity resolution, and the
 *   commit-SHA source ordering.
 */

import { PiOmpGitError } from "../../shared/errors.ts";
import {
	checkPrUrlRepoConflict,
	type PrIdentifier,
	parsePrIdentifier,
} from "../pr-ref.ts";
import { type GithubRepoIdentity, parseGithubRepoIdentifier } from "../repo.ts";

export type { GithubRepoIdentity };

// ---------------------------------------------------------------------------
// PR checkout planning
// ---------------------------------------------------------------------------

/** The payload fields the checkout target plan reads from `gh pr view`. */
export interface CheckoutPayloadView {
	number: number;
	url?: string;
	headRefName?: string;
	headRepository?: { name?: string; owner?: { login?: string } } | null;
	headRepositoryOwner?: { login?: string } | null;
	isCrossRepository?: boolean;
	maintainerCanModify?: boolean;
}

/**
 * Normalize the raw `pr` parameter into the ordered batch of identifiers:
 * trimmed, empty entries dropped, and an empty result rejected with the
 * pipeline-level error (dispatcher validation runs first; this is the
 * defense in depth behind it).
 */
export function planPrCheckoutBatch(pr: string | string[]): string[] {
	const identifiers = (Array.isArray(pr) ? pr : [pr])
		.map((value) => value.trim())
		.filter((value) => value !== "");
	if (identifiers.length === 0) {
		throw new PiOmpGitError(
			"The `pr` parameter is required for pr_checkout — a PR number as text, a PR URL, or a branch-like identifier.",
		);
	}
	return identifiers;
}

/**
 * Parse one checkout identifier and check it against an explicit `repo`
 * (D3: a PR URL already names its repository). Throws for identifiers that
 * are not a number, a PR URL, or a branch-like ref.
 */
export function planPrCheckoutRef(
	identifier: string,
	explicitRepo: string | undefined,
): PrIdentifier {
	const parsed = parsePrIdentifier(identifier);
	if (!parsed) {
		throw new PiOmpGitError(
			`Invalid PR identifier: ${identifier}. Use a PR number as text, a PR URL, or a branch-like identifier.`,
		);
	}
	checkPrUrlRepoConflict(parsed, explicitRepo);
	return parsed;
}

/**
 * The pure part of base-identity resolution: a PR URL names its own
 * repository; an explicit `repo` parses as `host/owner/repo` or
 * `owner/repo` (host filled from `GH_HOST`). Returns null when the caller
 * must resolve the identity from the current checkout instead.
 */
export function planBaseIdentity(
	parsed: PrIdentifier,
	explicitRepo: string | undefined,
	ghHost: string | undefined,
): GithubRepoIdentity | null {
	if (parsed.kind === "url") {
		return { host: parsed.host, owner: parsed.owner, repo: parsed.repo };
	}
	if (explicitRepo) {
		const segments = explicitRepo.trim().split("/").filter(Boolean);
		if (segments.length === 3) {
			return {
				host: segments[0] ?? "",
				owner: segments[1] ?? "",
				repo: segments[2] ?? "",
			};
		}
		if (segments.length === 2) {
			return {
				host: ghHost ?? "github.com",
				owner: segments[0] ?? "",
				repo: segments[1] ?? "",
			};
		}
	}
	return null;
}

/** How the adapter materializes the PR head commit locally. */
export type CheckoutFetchPlan =
	| {
			kind: "fork";
			head: { host: string; owner: string; name: string };
			ref: string;
	  }
	| { kind: "origin"; ref: string };

/** The pure checkout decisions derived from one `gh pr view` payload. */
export interface CheckoutTargetPlan {
	/** The managed local branch: `pr-<number>` (§25). */
	branch: string;
	/** The fork branch to fetch, with the `pull/<n>/head` fallback. */
	headRefName: string;
	/** The PR web URL, with the constructed fallback. */
	pullUrl: string;
	headOwner?: string;
	headRepoName?: string;
	crossRepository: boolean;
	maintainerCanModify: boolean;
	/** Where to fetch the head commit from (§29 fork handling). */
	fetch: CheckoutFetchPlan;
}

/**
 * Plan one checkout target from a parsed `gh pr view` payload and the base
 * identity. Mirrors the historical inline decisions exactly: same fallbacks,
 * same cross-repository inference when `isCrossRepository` is omitted, same
 * fork-vs-origin fetch choice.
 */
export function planCheckoutTarget(
	payload: CheckoutPayloadView,
	baseIdentity: GithubRepoIdentity,
): CheckoutTargetPlan {
	const headRefName = payload.headRefName ?? `pull/${payload.number}/head`;
	const pullUrl =
		payload.url ??
		`https://${baseIdentity.host}/${baseIdentity.owner}/${baseIdentity.repo}/pull/${payload.number}`;
	const headOwner =
		payload.headRepositoryOwner?.login ?? payload.headRepository?.owner?.login;
	const headRepoName = payload.headRepository?.name;
	const crossRepository =
		payload.isCrossRepository ??
		Boolean(
			headOwner &&
				headRepoName &&
				(headOwner.toLowerCase() !== baseIdentity.owner.toLowerCase() ||
					headRepoName.toLowerCase() !== baseIdentity.repo.toLowerCase()),
		);
	const maintainerCanModify = payload.maintainerCanModify ?? false;
	const branch = `pr-${payload.number}`;
	const fetch: CheckoutFetchPlan =
		crossRepository && headOwner && headRepoName
			? {
					kind: "fork",
					head: {
						host: baseIdentity.host,
						owner: headOwner,
						name: headRepoName,
					},
					ref: headRefName,
				}
			: { kind: "origin", ref: `pull/${payload.number}/head` };
	return {
		branch,
		headRefName,
		pullUrl,
		...(headOwner ? { headOwner } : {}),
		...(headRepoName ? { headRepoName } : {}),
		crossRepository,
		maintainerCanModify,
		fetch,
	};
}

// ---------------------------------------------------------------------------
// Actions watching planning
// ---------------------------------------------------------------------------

/** A bare Actions run ID. */
export interface ParsedRunRef {
	kind: "number";
	number: number;
}

/** A full Actions run URL: `<host>/<owner>/<repo>/actions/runs/<id>`. */
export interface ParsedRunUrl {
	kind: "url";
	host: string;
	owner: string;
	repo: string;
	number: number;
}

/**
 * `run` accepts a bare run ID or a GitHub Actions run URL:
 * `https://<host>/<owner>/<repo>/actions/runs/<id>` (optional
 * `/attempts/<n>` suffix). Everything else is invalid.
 */
export function parseRunIdentifier(
	text: string,
): ParsedRunRef | ParsedRunUrl | null {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	if (/^\d+$/.test(trimmed)) {
		return { kind: "number", number: Number(trimmed) };
	}
	if (/^https?:\/\//i.test(trimmed)) {
		const match =
			/^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?\/?$/i.exec(
				trimmed,
			);
		if (!match) return null;
		return {
			kind: "url",
			host: match[1]?.toLowerCase() ?? "github.com",
			owner: match[2] ?? "",
			repo: match[3] ?? "",
			number: Number(match[4]),
		};
	}
	return null;
}

/** A run URL and an explicit `repo` must agree (divergence D3 pattern). */
export function checkRunUrlRepoConflict(
	parsed: ParsedRunUrl,
	repoParam: string | undefined,
): void {
	if (!repoParam) return;
	const explicit = parseGithubRepoIdentifier(repoParam);
	if (!explicit) return;
	if (
		explicit.host &&
		parsed.host &&
		explicit.host.toLowerCase() !== parsed.host
	) {
		throw new PiOmpGitError(
			`The Actions run URL points at ${parsed.host} but \`repo\` targets ${explicit.host}. Pass the matching repository or omit \`repo\`.`,
		);
	}
	if (
		explicit.owner.toLowerCase() !== parsed.owner.toLowerCase() ||
		explicit.repo.toLowerCase() !== parsed.repo.toLowerCase()
	) {
		throw new PiOmpGitError(
			`The Actions run URL points at ${parsed.owner}/${parsed.repo} but \`repo\` targets ${explicit.owner}/${explicit.repo}. Pass the matching repository or omit \`repo\`.`,
		);
	}
}

/** The pure run/commit-mode target decisions for `run_watch` (§40). */
export interface WatchTargetPlan {
	mode: "run" | "commit";
	runNumber?: number;
	/** Identity derived from a run URL. */
	urlIdentity?: GithubRepoIdentity;
	/** Identity derived from an explicit `repo`. */
	repoIdentity?: GithubRepoIdentity;
	/** True when the caller must resolve the current repository. */
	needsCurrentRepo: boolean;
}

/**
 * Plan the watch target from the raw inputs. Run mode parses the run
 * identifier (run ID or URL) and checks a URL against an explicit `repo`;
 * the repository identity comes from the URL when present, else the
 * explicit `repo`, else the caller resolves the current checkout.
 */
export function planWatchTarget(input: {
	run?: string;
	repo?: string;
}): WatchTargetPlan {
	const mode: "run" | "commit" = input.run ? "run" : "commit";
	let runNumber: number | undefined;
	let urlIdentity: GithubRepoIdentity | undefined;
	if (input.run) {
		const parsed = parseRunIdentifier(input.run);
		if (!parsed) {
			throw new PiOmpGitError(
				`\`run\` must be a run ID or a GitHub Actions run URL — got ${JSON.stringify(input.run)}.`,
			);
		}
		runNumber = parsed.number;
		if (parsed.kind === "url") {
			checkRunUrlRepoConflict(parsed, input.repo);
			urlIdentity = {
				host: parsed.host,
				owner: parsed.owner,
				repo: parsed.repo,
			};
		}
	}
	let repoIdentity: GithubRepoIdentity | undefined;
	if (!urlIdentity && input.repo) {
		const parsed = parseGithubRepoIdentifier(input.repo);
		if (!parsed) {
			throw new PiOmpGitError(
				`\`repo\` must be owner/repo or host/owner/repo — got ${JSON.stringify(input.repo)}.`,
			);
		}
		repoIdentity = {
			host: parsed.host ?? "github.com",
			owner: parsed.owner,
			repo: parsed.repo,
		};
	}
	return {
		mode,
		...(runNumber !== undefined ? { runNumber } : {}),
		...(urlIdentity ? { urlIdentity } : {}),
		...(repoIdentity ? { repoIdentity } : {}),
		needsCurrentRepo: !urlIdentity && !repoIdentity,
	};
}

/** Where the commit-SHA resolver should source the SHA from, in order. */
export type CommitShaSourcePlan =
	| { kind: "commit"; sha: string }
	| { kind: "pr"; pr: string }
	| { kind: "last-checkout"; branch: string }
	| { kind: "head" };

/**
 * Plan the commit-SHA source (§40 commit mode): an explicit `commit` is
 * validated and wins, then a `pr` resolved through `gh`, then the branch of
 * the last managed checkout, then the caller's HEAD. The adapter executes
 * the pr/last-checkout/head steps through its existing gh/git adapters.
 */
export function planCommitShaSource(input: {
	commit?: string;
	pr?: string;
	lastBranch?: string | null;
}): CommitShaSourcePlan {
	if (input.commit) {
		const sha = input.commit.trim();
		if (!/^[0-9a-f]{4,40}$/i.test(sha)) {
			throw new PiOmpGitError(
				`\`commit\` must be a commit SHA — got ${JSON.stringify(input.commit)}.`,
			);
		}
		return { kind: "commit", sha };
	}
	if (input.pr) {
		return { kind: "pr", pr: input.pr.trim() };
	}
	if (input.lastBranch) {
		return { kind: "last-checkout", branch: input.lastBranch };
	}
	return { kind: "head" };
}
