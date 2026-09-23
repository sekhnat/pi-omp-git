/**
 * `pr://N` single-resource fetch — ticket 04
 * (docs/pi-omp-git-reference.md §11–§14).
 *
 * One `gh pr view --json` call carries the metadata, files, reviews, and
 * ordinary conversation comments; line-level review comments are collected
 * separately through the REST equivalent of
 * `GET /repos/{owner}/{repo}/pulls/{number}/comments`, paginated at 100
 * per page (§13). With `?comments=0` the discussion material is not even
 * requested — the expensive fields are omitted from the view call and the
 * review-comments call never runs (§14).
 *
 * Older `gh` versions that reject newer JSON fields trigger a retry with
 * the field omitted (§11). Minimized comments are excluded (§11).
 */

import {
	AuthenticationError,
	DependencyError,
	FRIENDLY_ERRORS,
	InvalidJsonError,
	NoRepositoryContextError,
	PiOmpGitError,
	ResourceNotFoundError,
} from "../../shared/errors.ts";
import {
	CommandNotFoundError,
	type RunResult,
} from "../../shared/subprocess.ts";
import type { GhRunner } from "../runner.ts";
import { sanitizeStderr } from "./issues.ts";

export interface GhComment {
	author?: string;
	body: string;
	createdAt?: string;
}

export interface GhReview {
	author?: string;
	state: string;
	body: string;
	submittedAt?: string;
	url?: string;
}

/** Normalized line-level review comment (§13). */
export interface GhReviewComment {
	id: number;
	author?: string;
	body: string;
	createdAt?: string;
	inReplyToId?: number;
	path?: string;
	line?: number;
	originalLine?: number;
	side?: string;
	url?: string;
}

export interface GhPullFile {
	path: string;
	previousPath?: string;
	changeType?: string;
	additions?: number;
	deletions?: number;
}

export interface GhPull {
	number: number;
	title: string;
	state: string;
	isDraft: boolean;
	author?: string;
	baseRefName?: string;
	headRefName?: string;
	reviewDecision?: string;
	mergeStateStatus?: string;
	body: string;
	labels: string[];
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	files: GhPullFile[];
	reviews: GhReview[];
	/** Ordinary conversation comments, minimized entries removed. */
	comments: GhComment[];
	/** Line-level review comments, collected separately (§13). */
	reviewComments: GhReviewComment[];
}

export interface PullTarget {
	host?: string;
	owner: string;
	repo: string;
	number: number;
	comments: boolean;
}

/** Full field set — mirrors `gh pr view --json` as of the reference spec. */
export const PR_FIELDS =
	"number,title,state,isDraft,author,baseRefName,headRefName,reviewDecision,mergeStateStatus,body,labels,createdAt,updatedAt,url,files,reviews,comments";

/** Legacy retry set: drops the newest field (`mergeStateStatus`) (§11). */
export const PR_FIELDS_LEGACY = PR_FIELDS.replace(",mergeStateStatus", "");

/** Fields for suppressed reads — no expensive discussion material (§14). */
export const PR_FIELDS_NO_COMMENTS = PR_FIELDS.replace(",reviews,comments", "");

/**
 * Legacy retry set for suppressed reads — still carries no discussion
 * material, so the §11 fallback cannot re-request reviews/comments that
 * §14 omitted.
 */
export const PR_FIELDS_LEGACY_NO_COMMENTS = PR_FIELDS_NO_COMMENTS.replace(
	",mergeStateStatus",
	"",
);

const REVIEW_COMMENTS_PAGE_SIZE = 100;

interface RawComment {
	author?: { login?: string };
	body?: string;
	createdAt?: string;
	isMinimized?: boolean;
}

interface RawReview {
	author?: { login?: string };
	state?: string;
	body?: string;
	submittedAt?: string;
	url?: string;
}

interface RawReviewComment {
	id?: number;
	user?: { login?: string };
	body?: string;
	created_at?: string;
	in_reply_to_id?: number;
	path?: string;
	line?: number | null;
	original_line?: number | null;
	side?: string;
	html_url?: string;
	url?: string;
}

interface RawPullFile {
	path?: string;
	previous_path?: string;
	changeType?: string;
	additions?: number;
	deletions?: number;
}

interface RawPull {
	number?: number;
	title?: string;
	state?: string;
	isDraft?: boolean;
	author?: { login?: string };
	baseRefName?: string;
	headRefName?: string;
	reviewDecision?: string | null;
	mergeStateStatus?: string | null;
	body?: string | null;
	labels?: Array<{ name?: string }>;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	files?: RawPullFile[];
	reviews?: RawReview[];
	comments?: RawComment[];
}

/** `gh pr view <N> -R owner/repo --json <fields>` */
export function prViewArgs(target: PullTarget, fields: string): string[] {
	return [
		"pr",
		"view",
		String(target.number),
		"-R",
		`${target.owner}/${target.repo}`,
		"--json",
		fields,
	];
}

/**
 * The REST path for line-level review comments (§13), paginated at 100
 * per page with `--slurp` collecting the pages into one JSON array.
 */
export function reviewCommentsArgs(target: PullTarget): string[] {
	return [
		"api",
		`repos/${target.owner}/${target.repo}/pulls/${target.number}/comments?per_page=${REVIEW_COMMENTS_PAGE_SIZE}`,
		"--paginate",
		"--slurp",
	];
}

export function runOptions(target: PullTarget): {
	extraEnv?: Record<string, string>;
} {
	return target.host ? { extraEnv: { GH_HOST: target.host } } : {};
}

/** Classify a failed gh run into the stable error taxonomy (§49). */
export function classifyPullFailure(
	target: PullTarget,
	result: RunResult,
): PiOmpGitError {
	const stderr = result.stderr.toLowerCase();
	if (/not authenticated|authentication|auth login/.test(stderr)) {
		return new AuthenticationError();
	}
	if (/unknown json field/.test(result.stderr)) {
		// The retry path handles the unsupported-field case; reaching here
		// means the retry also failed.
		return new InvalidJsonError(
			`${FRIENDLY_ERRORS.invalidJson} (unsupported JSON field on this gh version)`,
		);
	}
	if (/not found|could not resolve to a pull request/.test(stderr)) {
		return new ResourceNotFoundError(
			`GitHub pull request #${target.number} was not found in ${target.owner}/${target.repo}. ${sanitizeStderr(result)}`.trim(),
		);
	}
	if (
		/current repository|git remote|not a git repository|not in a git|could not determine/.test(
			result.stderr,
		)
	) {
		return new NoRepositoryContextError();
	}
	const details = sanitizeStderr(result);
	return new PiOmpGitError(
		details
			? `GitHub command failed: ${details}`
			: `GitHub command failed with exit code ${result.exitCode ?? "signal"}`,
	);
}

function normalizeComments(raw: RawComment[] | undefined): GhComment[] {
	return (raw ?? [])
		.filter(
			(comment) =>
				comment.isMinimized !== true && typeof comment.body === "string",
		)
		.map((comment) => ({
			author: comment.author?.login,
			body: comment.body ?? "",
			createdAt: comment.createdAt,
		}));
}

function parseReviewComments(stdout: string): GhReviewComment[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new InvalidJsonError();
	}
	if (!Array.isArray(parsed)) {
		throw new InvalidJsonError();
	}
	return (parsed as RawReviewComment[])
		.filter((comment) => typeof comment?.id === "number")
		.map((comment) => ({
			id: comment.id ?? 0,
			author: comment.user?.login,
			body: comment.body ?? "",
			createdAt: comment.created_at,
			inReplyToId: comment.in_reply_to_id ?? undefined,
			path: comment.path ?? undefined,
			line: comment.line ?? undefined,
			originalLine: comment.original_line ?? undefined,
			side: comment.side ?? undefined,
			url: comment.html_url ?? comment.url,
		}));
}

function parsePullPayload(
	stdout: string,
	reviewComments: GhReviewComment[],
): GhPull {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new InvalidJsonError();
	}
	const raw = parsed as RawPull;
	if (typeof raw?.number !== "number") {
		throw new InvalidJsonError();
	}
	return {
		number: raw.number,
		title: raw.title ?? "",
		state: raw.state ?? "",
		isDraft: raw.isDraft === true,
		author: raw.author?.login,
		baseRefName: raw.baseRefName ?? undefined,
		headRefName: raw.headRefName ?? undefined,
		reviewDecision: raw.reviewDecision ?? undefined,
		mergeStateStatus: raw.mergeStateStatus ?? undefined,
		body: raw.body ?? "",
		labels: (raw.labels ?? [])
			.map((label) => label.name ?? "")
			.filter((name) => name !== ""),
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		url: raw.url,
		files: (raw.files ?? [])
			.filter((file) => typeof file?.path === "string" && file.path !== "")
			.map((file) => ({
				path: file.path ?? "",
				previousPath: file.previous_path ?? undefined,
				changeType: file.changeType ?? undefined,
				additions: file.additions ?? undefined,
				deletions: file.deletions ?? undefined,
			})),
		reviews: (raw.reviews ?? [])
			.filter((review) => typeof review?.body === "string")
			.map((review) => ({
				author: review.author?.login,
				state: review.state ?? "",
				body: review.body ?? "",
				submittedAt: review.submittedAt,
				url: review.url,
			})),
		comments: normalizeComments(raw.comments),
		reviewComments,
	};
}

/**
 * Fetch one pull request live. The repository is always explicit — bare
 * `pr://N` URIs resolve the current checkout's repository locally before
 * this call, because the review-comments REST path needs owner/repo
 * regardless (§13).
 */
export async function fetchPullRequest(
	gh: GhRunner,
	target: PullTarget,
	signal?: AbortSignal,
): Promise<GhPull> {
	const fields = target.comments ? PR_FIELDS : PR_FIELDS_NO_COMMENTS;
	let result: RunResult;
	try {
		result = await gh.run(prViewArgs(target, fields), {
			signal,
			...runOptions(target),
		});
	} catch (error) {
		if (error instanceof CommandNotFoundError) {
			throw new DependencyError(FRIENDLY_ERRORS.ghMissing, "gh");
		}
		throw error;
	}

	if (result.exitCode !== 0) {
		if (/unknown json field/i.test(result.stderr)) {
			// Older gh: retry with the unsupported field omitted (§11).
			const retry = await gh.run(
				prViewArgs(
					target,
					target.comments ? PR_FIELDS_LEGACY : PR_FIELDS_LEGACY_NO_COMMENTS,
				),
				{
					signal,
					...runOptions(target),
				},
			);
			if (retry.exitCode !== 0) {
				throw classifyPullFailure(target, retry);
			}
			return parsePullPayload(
				retry.stdout,
				target.comments ? await fetchReviewComments(gh, target, signal) : [],
			);
		}
		throw classifyPullFailure(target, result);
	}

	return parsePullPayload(
		result.stdout,
		target.comments ? await fetchReviewComments(gh, target, signal) : [],
	);
}

/** Line-level review comments, 100 per page (§13). */
export async function fetchReviewComments(
	gh: GhRunner,
	target: PullTarget,
	signal?: AbortSignal,
): Promise<GhReviewComment[]> {
	let result: RunResult;
	try {
		result = await gh.run(reviewCommentsArgs(target), {
			signal,
			...runOptions(target),
		});
	} catch (error) {
		if (error instanceof CommandNotFoundError) {
			throw new DependencyError(FRIENDLY_ERRORS.ghMissing, "gh");
		}
		throw error;
	}
	if (result.exitCode !== 0) {
		throw classifyPullFailure(target, result);
	}
	return parseReviewComments(result.stdout);
}
