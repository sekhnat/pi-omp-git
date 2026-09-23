/** Live, filtered issue and pull-request listings for `issue://` and `pr://` (§10). */

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

export interface GithubListTarget {
	host: string;
	owner: string;
	repo: string;
	state: string;
	limit: number;
	author?: string;
	label?: string;
}

export interface GhIssueListItem {
	number: number;
	title: string;
	state: string;
	author?: string;
	labels: string[];
	updatedAt?: string;
	url?: string;
}

export interface GhPullListItem extends GhIssueListItem {
	isDraft: boolean;
}

const ISSUE_LIST_FIELDS = "number,title,state,author,labels,updatedAt,url";
const PR_LIST_FIELDS = "number,title,state,isDraft,author,labels,updatedAt,url";

export async function fetchIssueList(
	gh: GhRunner,
	target: GithubListTarget,
	signal?: AbortSignal,
): Promise<GhIssueListItem[]> {
	const stdout = await runListCommand(
		gh,
		target,
		"issue",
		listArgs("issue", target, ISSUE_LIST_FIELDS),
		signal,
	);
	return parseListPayload(stdout).map(parseCommonItem);
}

export async function fetchPullRequestList(
	gh: GhRunner,
	target: GithubListTarget,
	signal?: AbortSignal,
): Promise<GhPullListItem[]> {
	const stdout = await runListCommand(
		gh,
		target,
		"PR",
		listArgs("pr", target, PR_LIST_FIELDS),
		signal,
	);
	return parseListPayload(stdout).map(parsePullItem);
}

function listArgs(
	kind: "issue" | "pr",
	target: GithubListTarget,
	fields: string,
): string[] {
	const args = [
		kind,
		"list",
		"--repo",
		`${target.owner}/${target.repo}`,
		"--state",
		target.state,
		"--limit",
		String(target.limit),
	];
	if (target.author !== undefined) args.push("--author", target.author);
	if (target.label !== undefined) args.push("--label", target.label);
	args.push("--json", fields);
	return args;
}

async function runListCommand(
	gh: GhRunner,
	target: GithubListTarget,
	kind: "issue" | "PR",
	args: string[],
	signal?: AbortSignal,
): Promise<string> {
	let result: RunResult;
	try {
		result = await gh.run(args, {
			signal,
			extraEnv: { GH_HOST: target.host },
		});
	} catch (error) {
		if (error instanceof CommandNotFoundError) {
			throw new DependencyError(FRIENDLY_ERRORS.ghMissing, "gh");
		}
		throw error;
	}
	if (result.truncated) {
		throw new PiOmpGitError(`GitHub ${kind} listing output was truncated.`);
	}
	if (result.exitCode !== 0) throw classifyListFailure(target, kind, result);
	return result.stdout;
}

function classifyListFailure(
	target: GithubListTarget,
	kind: "issue" | "PR",
	result: RunResult,
): PiOmpGitError {
	const stderr = result.stderr.toLowerCase();
	if (/not authenticated|authentication|auth login/.test(stderr)) {
		return new AuthenticationError();
	}
	if (/not found|could not resolve to/.test(stderr)) {
		return new ResourceNotFoundError(
			`GitHub repository ${target.owner}/${target.repo} was not found on ${target.host}. ${sanitizeStderr(result)}`.trim(),
		);
	}
	if (
		/current repository|git remote|not a git repository|not in a git|could not determine/.test(
			stderr,
		)
	) {
		return new NoRepositoryContextError();
	}
	const details = sanitizeStderr(result);
	return new PiOmpGitError(
		details
			? `GitHub ${kind} listing failed: ${details}`
			: `GitHub ${kind} listing failed with exit code ${result.exitCode ?? "signal"}`,
	);
}

function parseListPayload(stdout: string): unknown[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new InvalidJsonError();
	}
	if (!Array.isArray(parsed)) throw new InvalidJsonError();
	return parsed;
}

function objectValue(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new InvalidJsonError();
	}
	return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
	if (typeof value !== "string") throw new InvalidJsonError();
	return value;
}

function optionalString(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new InvalidJsonError();
	return value;
}

function parseLabels(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new InvalidJsonError();
	return value.flatMap((label) => {
		if (!label || typeof label !== "object" || Array.isArray(label)) return [];
		const name = (label as Record<string, unknown>).name;
		return typeof name === "string" && name !== "" ? [name] : [];
	});
}

function parseCommonItem(value: unknown): GhIssueListItem {
	const raw = objectValue(value);
	if (
		typeof raw.number !== "number" ||
		!Number.isSafeInteger(raw.number) ||
		raw.number < 1
	) {
		throw new InvalidJsonError();
	}
	const author = raw.author;
	return {
		number: raw.number,
		title: requiredString(raw.title),
		state: requiredString(raw.state),
		author:
			author && typeof author === "object" && !Array.isArray(author)
				? optionalString((author as Record<string, unknown>).login)
				: undefined,
		labels: parseLabels(raw.labels),
		updatedAt: optionalString(raw.updatedAt),
		url: optionalString(raw.url),
	};
}

function parsePullItem(value: unknown): GhPullListItem {
	const raw = objectValue(value);
	if (raw.isDraft !== undefined && typeof raw.isDraft !== "boolean") {
		throw new InvalidJsonError();
	}
	return { ...parseCommonItem(raw), isDraft: raw.isDraft === true };
}
