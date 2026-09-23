/**
 * `issue://N` single-resource fetch — live through the gh runner
 * (caching arrives with ticket 03). Older `gh` versions that reject
 * newer JSON fields trigger a retry with the field omitted (§11).
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

export interface GhIssueComment {
	author?: string;
	body: string;
	createdAt?: string;
}

export interface GhIssue {
	number: number;
	title: string;
	state: string;
	stateReason?: string;
	author?: string;
	body?: string;
	labels: string[];
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	comments: GhIssueComment[];
}

export interface IssueTarget {
	host?: string;
	owner?: string;
	repo?: string;
	number: number;
	comments: boolean;
}

const ISSUE_FIELDS =
	"number,title,state,stateReason,author,body,labels,createdAt,updatedAt,url,comments";
const ISSUE_FIELDS_LEGACY =
	"number,title,state,author,body,labels,createdAt,updatedAt,url,comments";

interface RawComment {
	author?: { login?: string };
	body?: string;
	createdAt?: string;
	isMinimized?: boolean;
}

interface RawIssue {
	number?: number;
	title?: string;
	state?: string;
	stateReason?: string | null;
	author?: { login?: string };
	body?: string | null;
	labels?: Array<{ name?: string }>;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	comments?: RawComment[];
}

/** `gh issue view <N> [-R owner/repo] --json <fields>` */
function issueViewArgs(target: IssueTarget, fields: string): string[] {
	const args = ["issue", "view", String(target.number)];
	if (target.owner && target.repo) {
		args.push("-R", `${target.owner}/${target.repo}`);
	}
	args.push("--json", fields);
	return args;
}

function runOptions(target: IssueTarget): {
	extraEnv?: Record<string, string>;
} {
	return target.host ? { extraEnv: { GH_HOST: target.host } } : {};
}

/** Sanitized, bounded stderr for friendly errors — never echoes tokens. */
export function sanitizeStderr(result: RunResult): string {
	const line = result.stderr
		.split("\n")
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate.length > 0);
	if (!line) return "";
	return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** Classify a failed gh run into the stable error taxonomy (§49). */
function classifyFailure(
	target: IssueTarget,
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
	if (
		/not found|could not resolve to an issue|could not resolve to a pull request/i.test(
			stderr,
		)
	) {
		const scope =
			target.owner && target.repo
				? `${target.owner}/${target.repo}`
				: "the current repository";
		return new ResourceNotFoundError(
			`GitHub issue #${target.number} was not found in ${scope}. ${sanitizeStderr(result)}`.trim(),
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

function parseIssuePayload(stdout: string): GhIssue {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new InvalidJsonError();
	}
	const raw = parsed as RawIssue;
	if (typeof raw?.number !== "number") {
		throw new InvalidJsonError();
	}
	const comments = (raw.comments ?? [])
		.filter(
			(comment) =>
				comment.isMinimized !== true && typeof comment.body === "string",
		)
		.map((comment) => ({
			author: comment.author?.login,
			body: comment.body ?? "",
			createdAt: comment.createdAt,
		}));
	return {
		number: raw.number,
		title: raw.title ?? "",
		state: raw.state ?? "",
		stateReason: raw.stateReason ?? undefined,
		author: raw.author?.login,
		body: raw.body ?? "",
		labels: (raw.labels ?? [])
			.map((label) => label.name ?? "")
			.filter((name) => name !== ""),
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		url: raw.url,
		comments,
	};
}

/**
 * Fetch one issue live. `gh` resolves the repository from the current
 * checkout when the URI carries no owner/repo; host-qualified targets
 * set GH_HOST (never touching user authentication variables).
 */
export async function fetchIssue(
	gh: GhRunner,
	target: IssueTarget,
	signal?: AbortSignal,
): Promise<GhIssue> {
	let result: RunResult;
	try {
		result = await gh.run(issueViewArgs(target, ISSUE_FIELDS), {
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
			const retry = await gh.run(issueViewArgs(target, ISSUE_FIELDS_LEGACY), {
				signal,
				...runOptions(target),
			});
			if (retry.exitCode !== 0) {
				throw classifyFailure(target, retry);
			}
			return parseIssuePayload(retry.stdout);
		}
		throw classifyFailure(target, result);
	}

	return parseIssuePayload(result.stdout);
}
