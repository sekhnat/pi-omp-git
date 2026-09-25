/**
 * `github {op: "repo_view"}` — repository orientation metadata
 * (docs/pi-omp-git-reference.md §20).
 *
 * An explicit `repo` is passed to `gh repo view`; an omitted one relies on
 * gh's own resolution from the current checkout (§20: "If repo is omitted,
 * gh repository resolution is used"). Host-qualified identifiers
 * (`host/owner/repo`) route through `GH_HOST`, never by aliasing to
 * github.com (§50).
 */

import { type Static, Type } from "typebox";
import {
	AuthenticationError,
	DependencyError,
	FRIENDLY_ERRORS,
	GithubApiError,
	InvalidJsonError,
	NoRepositoryContextError,
	PiOmpGitError,
	ResourceNotFoundError,
} from "../../shared/errors.ts";
import {
	CommandNotFoundError,
	type RunResult,
} from "../../shared/subprocess.ts";
import { parseGithubRepoIdentifier } from "../repo.ts";
import type { GhRunner } from "../runner.ts";
import { optionalNonEmptyString } from "./params.ts";
export interface RepoViewTarget {
	/** `owner/repo` or `host/owner/repo`; omitted → gh resolves the checkout. */
	repo?: string;
	/** Requested branch, echoed in the result when given (§20). */
	branch?: string;
}

export const REPO_VIEW_OPERATION_PARAMETERS = Type.Object({
	op: Type.Literal("repo_view"),
	repo: Type.Optional(Type.String()),
	branch: Type.Optional(Type.String()),
});

export type RepoViewOperationArguments = Static<
	typeof REPO_VIEW_OPERATION_PARAMETERS
>;

export function validateRepoViewOperationArguments(
	params: Record<string, unknown>,
): RepoViewOperationArguments {
	const repo = optionalNonEmptyString(params, "repo");
	const branch = optionalNonEmptyString(params, "branch");
	return {
		op: "repo_view",
		...(repo !== undefined ? { repo } : {}),
		...(branch !== undefined ? { branch } : {}),
	};
}

export interface RepoView {
	nameWithOwner: string;
	description?: string;
	url?: string;
	defaultBranch?: string;
	visibility?: string;
	viewerPermission?: string;
	language?: string;
	stargazers?: number;
	forks?: number;
	archived?: boolean;
	isFork?: boolean;
	updatedAt?: string;
	homepage?: string;
	topics: string[];
}

export const REPO_VIEW_FIELDS = [
	"nameWithOwner",
	"owner",
	"description",
	"url",
	"defaultBranchRef",
	"visibility",
	"viewerPermission",
	"primaryLanguage",
	"stargazerCount",
	"forkCount",
	"isArchived",
	"isFork",
	"updatedAt",
	"homepageUrl",
	"repositoryTopics",
];

/** Older `gh` versions that reject the newest fields get this reduced set. */
export const REPO_VIEW_FIELDS_LEGACY = REPO_VIEW_FIELDS.filter(
	(field) => field !== "repositoryTopics",
);

interface RawRepoView {
	nameWithOwner?: string;
	owner?: { login?: string };
	name?: string;
	description?: string | null;
	url?: string;
	defaultBranchRef?: { name?: string } | null;
	visibility?: string;
	viewerPermission?: string | null;
	primaryLanguage?: { name?: string } | null;
	stargazerCount?: number;
	forkCount?: number;
	isArchived?: boolean;
	isFork?: boolean;
	updatedAt?: string;
	homepageUrl?: string | null;
	repositoryTopics?: Array<{ name?: string }> | null;
}

/** Sanitized, bounded stderr for friendly errors — never echoes tokens. */
function sanitizeStderr(result: RunResult): string {
	const line = result.stderr
		.split("\n")
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate.length > 0);
	if (!line) return "";
	return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** The parsed-and-validated form of a repo_view target. */
interface ResolvedRepoTarget {
	args: string[];
	runOptions: { extraEnv?: Record<string, string> };
	/** `owner/repo` as gh sees it, or undefined for checkout resolution. */
	scope: string | undefined;
}

function resolveRepoTarget(target: RepoViewTarget): ResolvedRepoTarget {
	if (!target.repo) {
		return { args: ["repo", "view"], runOptions: {}, scope: undefined };
	}
	const identifier = parseGithubRepoIdentifier(target.repo);
	if (!identifier) {
		throw new PiOmpGitError(
			`Invalid repository identifier: ${target.repo}. Use owner/repo or host/owner/repo.`,
		);
	}
	const repoArg = `${identifier.owner}/${identifier.repo}`;
	return {
		args: ["repo", "view", repoArg],
		runOptions: identifier.host
			? { extraEnv: { GH_HOST: identifier.host } }
			: {},
		scope: repoArg,
	};
}

/** `gh repo view [owner/repo] --json <fields>` — host via GH_HOST. */
function repoViewArgs(target: ResolvedRepoTarget, fields: string): string[] {
	return [...target.args, "--json", fields];
}

/** Classify a failed `gh repo view` into the stable error taxonomy (§49). */
function classifyFailure(
	target: ResolvedRepoTarget,
	result: RunResult,
): PiOmpGitError {
	const stderr = result.stderr.toLowerCase();
	if (/not authenticated|authentication|auth login/.test(stderr)) {
		return new AuthenticationError();
	}
	if (
		/could not resolve to a repository|not found|does not exist|no repository/i.test(
			result.stderr,
		)
	) {
		const scope = target.scope ?? "the current repository";
		const found = sanitizeStderr(result);
		return new ResourceNotFoundError(
			found
				? `GitHub repository ${scope} was not found or is not accessible. ${found}`
				: `GitHub repository ${scope} was not found or is not accessible.`,
		);
	}
	if (
		/current repository|git remote|not a git repository|not in a git|could not determine|no default remote/i.test(
			result.stderr,
		)
	) {
		return new NoRepositoryContextError();
	}
	const details = sanitizeStderr(result);
	return new GithubApiError(
		details
			? `GitHub repository view failed${target.scope ? ` for ${target.scope}` : ""}: ${details}`
			: `GitHub repository view failed${target.scope ? ` for ${target.scope}` : ""} with exit code ${result.exitCode ?? "signal"}`,
	);
}

function parseRepoViewPayload(stdout: string): RepoView {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new InvalidJsonError();
	}
	const raw = parsed as RawRepoView;
	if (!raw || typeof raw !== "object") {
		throw new InvalidJsonError();
	}
	const nameWithOwner =
		raw.nameWithOwner ??
		(raw.owner?.login && raw.name ? `${raw.owner.login}/${raw.name}` : "");
	if (!nameWithOwner) {
		throw new InvalidJsonError();
	}
	return {
		nameWithOwner,
		description: raw.description ?? undefined,
		url: raw.url,
		defaultBranch: raw.defaultBranchRef?.name ?? undefined,
		visibility: raw.visibility,
		viewerPermission: raw.viewerPermission ?? undefined,
		language: raw.primaryLanguage?.name ?? undefined,
		stargazers:
			typeof raw.stargazerCount === "number" ? raw.stargazerCount : undefined,
		forks: typeof raw.forkCount === "number" ? raw.forkCount : undefined,
		archived: raw.isArchived,
		isFork: raw.isFork,
		updatedAt: raw.updatedAt,
		homepage: raw.homepageUrl ?? undefined,
		topics: (raw.repositoryTopics ?? [])
			.map((topic) => topic.name ?? "")
			.filter((name) => name !== ""),
	};
}

/** Render the §20 metadata set as stable, scannable lines. */
export function renderRepoView(view: RepoView, branch?: string): string {
	const lines: string[] = [`# ${view.nameWithOwner}`];
	if (view.description) lines.push(`Description: ${view.description}`);
	if (view.url) lines.push(`URL: ${view.url}`);
	if (view.defaultBranch) lines.push(`Default branch: ${view.defaultBranch}`);
	if (branch) lines.push(`Requested branch: ${branch}`);
	if (view.visibility) lines.push(`Visibility: ${view.visibility}`);
	if (view.viewerPermission) {
		lines.push(`Viewer permission: ${view.viewerPermission}`);
	}
	if (view.language) lines.push(`Language: ${view.language}`);
	if (view.stargazers !== undefined) lines.push(`Stars: ${view.stargazers}`);
	if (view.forks !== undefined) lines.push(`Forks: ${view.forks}`);
	if (view.archived !== undefined)
		lines.push(`Archived: ${view.archived ? "yes" : "no"}`);
	if (view.isFork !== undefined)
		lines.push(`Fork: ${view.isFork ? "yes" : "no"}`);
	if (view.updatedAt) lines.push(`Updated: ${view.updatedAt}`);
	if (view.homepage) lines.push(`Homepage: ${view.homepage}`);
	if (view.topics.length > 0) lines.push(`Topics: ${view.topics.join(", ")}`);
	return `${lines.join("\n")}\n`;
}

/**
 * Fetch one repository view live. The requested `branch` is echoed in the
 * rendered result; gh performs repository resolution when `repo` is omitted.
 */
export async function fetchRepoView(
	gh: GhRunner,
	target: RepoViewTarget,
	signal?: AbortSignal,
): Promise<RepoView> {
	const resolved = resolveRepoTarget(target);
	let result: RunResult;
	try {
		result = await gh.run(repoViewArgs(resolved, REPO_VIEW_FIELDS.join(",")), {
			signal,
			...resolved.runOptions,
		});
	} catch (error) {
		if (error instanceof CommandNotFoundError) {
			throw new DependencyError(FRIENDLY_ERRORS.ghMissing, "gh");
		}
		throw error;
	}

	if (result.exitCode !== 0) {
		if (/unknown json field/i.test(result.stderr)) {
			// Older gh: retry with the unsupported field omitted (§11 pattern).
			const retry = await gh.run(
				repoViewArgs(resolved, REPO_VIEW_FIELDS_LEGACY.join(",")),
				{
					signal,
					...resolved.runOptions,
				},
			);
			if (retry.exitCode !== 0) {
				throw classifyFailure(resolved, retry);
			}
			return parseRepoViewPayload(retry.stdout);
		}
		throw classifyFailure(resolved, result);
	}

	return parseRepoViewPayload(result.stdout);
}
