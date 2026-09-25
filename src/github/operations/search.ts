/**
 * The five §34 search operations — `search_issues`, `search_prs`,
 * `search_code`, `search_commits`, `search_repos`
 * (docs/pi-omp-git-reference.md §34-§39).
 *
 * Searches hit the GitHub REST search API through `gh api` directly so
 * GitHub query syntax reaches the API unaltered (§34) — no CLI layer
 * rewrites semantics. Issues/PRs/code/commits scope to the current
 * checkout when no repository is given, unless the query already carries
 * a broad explicit scope (§36); resolution failure lets the search
 * proceed globally. `search_repos` ignores `repo` entirely. Results
 * render agent-useful fields with canonical URLs (§39), never raw JSON.
 */

import { type Static, Type } from "typebox";
import type { GitRunner } from "../../git/runner.ts";
import {
	AuthenticationError,
	DependencyError,
	FRIENDLY_ERRORS,
	GithubApiError,
	InvalidJsonError,
	NoRepositoryContextError,
	PiOmpGitError,
} from "../../shared/errors.ts";
import {
	CommandNotFoundError,
	type RunResult,
} from "../../shared/subprocess.ts";
import {
	parseGithubRepoIdentifier,
	resolveCurrentGithubRepo,
} from "../repo.ts";
import type { GhRunner } from "../runner.ts";
import { sanitizeStderr } from "./file-read.ts";
import { GithubParamsError, optionalNonEmptyString } from "./params.ts";

/** The search operations served by this module. */
export const SEARCH_OPERATION_NAMES = [
	"search_issues",
	"search_prs",
	"search_code",
	"search_commits",
	"search_repos",
] as const;

export type SearchOperation = (typeof SEARCH_OPERATION_NAMES)[number];

export function searchOperationParameters<Operation extends SearchOperation>(
	operation: Operation,
) {
	return Type.Object({
		op: Type.Literal(operation),
		repo: Type.Optional(Type.String()),
		query: Type.String({ minLength: 1 }),
		since: Type.Optional(Type.String()),
		until: Type.Optional(Type.String()),
		dateField: Type.Optional(
			Type.Union([Type.Literal("created"), Type.Literal("updated")]),
		),
		limit: Type.Optional(Type.Number()),
	});
}

export type SearchOperationArguments<Operation extends SearchOperation> = Omit<
	Static<ReturnType<typeof searchOperationParameters>>,
	"op"
> & { op: Operation };

export function validateSearchOperationArguments<
	Operation extends SearchOperation,
>(
	operation: Operation,
	params: Record<string, unknown>,
): SearchOperationArguments<Operation> {
	const repo = optionalNonEmptyString(params, "repo");
	const query = optionalNonEmptyString(params, "query");
	if (query === undefined) {
		throw new GithubParamsError(
			`The \`${operation}\` operation requires a non-empty \`query\` parameter.`,
		);
	}
	const since = optionalNonEmptyString(params, "since");
	const until = optionalNonEmptyString(params, "until");
	const rawDateField = params.dateField;
	if (
		rawDateField !== undefined &&
		rawDateField !== null &&
		rawDateField !== "created" &&
		rawDateField !== "updated"
	) {
		throw new GithubParamsError(
			'The `dateField` parameter must be "created" or "updated".',
		);
	}
	const rawLimit = params.limit;
	if (
		rawLimit !== undefined &&
		rawLimit !== null &&
		typeof rawLimit !== "number"
	) {
		throw new GithubParamsError(
			"The `limit` parameter must be a number between 1 and 50.",
		);
	}
	return {
		op: operation,
		...(repo !== undefined ? { repo } : {}),
		query,
		...(since !== undefined ? { since } : {}),
		...(until !== undefined ? { until } : {}),
		...(rawDateField !== undefined && rawDateField !== null
			? { dateField: rawDateField }
			: {}),
		...(typeof rawLimit === "number" ? { limit: rawLimit } : {}),
	};
}

export interface SearchTarget {
	/** `owner/repo` or `host/owner/repo`; ignored by `search_repos` (§36). */
	repo?: string;
	/** GitHub search query — reaches the API unaltered (§34). */
	query: string;
	/** Lower date bound (§37 grammar); rejected by code search (§38). */
	since?: string;
	/** Upper date bound (§37 grammar); rejected by code search (§38). */
	until?: string;
	/** Which timestamp the date bounds filter (§38); default `created`. */
	dateField?: "created" | "updated";
	/** Result count (§35): default 10, max 50. */
	limit?: number;
}

export interface SearchDeps {
	gh: GhRunner;
	git: GitRunner;
	env: NodeJS.ProcessEnv;
}

export interface SearchRun {
	/** The GitHub-reported total before the limit. */
	totalCount: number;
	/** Effective `owner/repo` scope when one applied (§36). */
	scope?: string;
	/** The exact query string sent to the API (qualifiers appended). */
	finalQuery: string;
	/** Agent-rendered results (§39). */
	rendered: string;
}

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;

const SEARCH_ENDPOINTS: Record<SearchOperation, string> = {
	search_issues: "search/issues",
	search_prs: "search/issues",
	search_code: "search/code",
	search_commits: "search/commits",
	search_repos: "search/repositories",
};

const SEARCH_LABELS: Record<SearchOperation, string> = {
	search_issues: "issue",
	search_prs: "pull request",
	search_code: "code",
	search_commits: "commit",
	search_repos: "repository",
};

/** §35 limit policy: default 10, reject non-finite/≤0, floor, clamp 50. */
export function parseSearchLimit(limit: unknown): number {
	if (limit === undefined || limit === null) return DEFAULT_SEARCH_LIMIT;
	if (typeof limit !== "number" || !Number.isFinite(limit)) {
		throw new PiOmpGitError(
			"The `limit` parameter must be a finite number between 1 and 50.",
		);
	}
	if (limit <= 0) {
		throw new PiOmpGitError(
			"The `limit` parameter must be positive (between 1 and 50).",
		);
	}
	return Math.min(MAX_SEARCH_LIMIT, Math.floor(limit));
}

/** Relative dates: minutes, hours, days, weeks, months, years (§37). */
const RELATIVE_DATE = /^(\d+)(mo|m|h|d|w|y)$/;

/** Absolute dates: YYYY-MM-DD, optionally an ISO-8601 time part. */
const ABSOLUTE_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Parse a §37 date and return the qualifier value: relative units become
 * an ISO-8601 instant (seconds precision, UTC) interpreted at invocation
 * time; absolute dates pass through unaltered. Rejects anything else.
 */
export function parseSearchDate(
	value: string,
	field: "since" | "until",
	now: Date = new Date(),
): string {
	const match = RELATIVE_DATE.exec(value.trim());
	if (match) {
		const amount = Number(match[1]);
		const unit = match[2];
		const shifted = new Date(now.getTime());
		switch (unit) {
			case "m":
				shifted.setUTCMinutes(shifted.getUTCMinutes() - amount);
				break;
			case "h":
				shifted.setUTCHours(shifted.getUTCHours() - amount);
				break;
			case "d":
				shifted.setUTCDate(shifted.getUTCDate() - amount);
				break;
			case "w":
				shifted.setUTCDate(shifted.getUTCDate() - amount * 7);
				break;
			case "mo":
				shifted.setUTCMonth(shifted.getUTCMonth() - amount);
				break;
			case "y":
				shifted.setUTCFullYear(shifted.getUTCFullYear() - amount);
				break;
		}
		// GitHub date qualifiers accept ISO-8601 with second precision.
		return shifted.toISOString().replace(/\.\d{3}Z$/, "Z");
	}
	const trimmed = value.trim();
	if (ABSOLUTE_DATE.test(trimmed) && !Number.isNaN(Date.parse(trimmed))) {
		return trimmed;
	}
	throw new PiOmpGitError(
		`Invalid ${field} date "${value}". Use relative units (3m, 12h, 7d, 2w, 3mo, 1y), YYYY-MM-DD, or an ISO-8601 datetime.`,
	);
}

/** Queries already carrying one of these scopes are not re-scoped (§36). */
const BROAD_SCOPE = /\b(?:repo|org|user|owner):/;

/** True when the query itself declares repo:/org:/user:/owner: scope. */
export function hasBroadScope(query: string): boolean {
	return BROAD_SCOPE.test(query);
}

interface ResolvedScope {
	/** `owner/repo` when the search is repo-scoped (§36). */
	scope?: string;
	host: string;
}

/**
 * Resolve the effective scope and host. Explicit `repo` wins; an omitted
 * repo resolves the current checkout locally — and a resolution failure
 * lets the search proceed globally (§36). `search_repos` ignores `repo`.
 */
async function resolveSearchScope(
	deps: SearchDeps,
	operation: SearchOperation,
	target: SearchTarget,
	signal?: AbortSignal,
): Promise<ResolvedScope> {
	if (operation === "search_repos") {
		return { host: deps.env.GH_HOST ?? "github.com" };
	}
	if (target.repo) {
		const identifier = parseGithubRepoIdentifier(target.repo);
		if (!identifier) {
			throw new PiOmpGitError(
				`Invalid repository identifier: ${target.repo}. Use owner/repo or host/owner/repo.`,
			);
		}
		return {
			scope: `${identifier.owner}/${identifier.repo}`,
			host: identifier.host ?? deps.env.GH_HOST ?? "github.com",
		};
	}
	try {
		const resolved = await resolveCurrentGithubRepo(
			{ git: deps.git, env: deps.env },
			signal,
		);
		if (hasBroadScope(target.query)) {
			// §36: the query already declares repo:/org:/user:/owner: scope.
			return { host: resolved.host };
		}
		return { scope: `${resolved.owner}/${resolved.repo}`, host: resolved.host };
	} catch (error) {
		if (error instanceof NoRepositoryContextError) {
			// §36: allow the search to proceed globally.
			return { host: deps.env.GH_HOST ?? "github.com" };
		}
		throw error;
	}
}

/** Map `dateField` to the per-resource qualifier field (§38). */
function dateFieldName(
	operation: SearchOperation,
	dateField: "created" | "updated" | undefined,
): string {
	if (operation === "search_commits") return "committer-date";
	if (operation === "search_repos" && dateField === "updated") return "pushed";
	return dateField ?? "created";
}

/** Code search must not carry date filters (§38); check before any I/O. */
function assertSearchDatesAllowed(
	operation: SearchOperation,
	target: SearchTarget,
): void {
	if (operation === "search_code" && (target.since || target.until)) {
		throw new PiOmpGitError(
			"search_code does not support since/until date filters (§38).",
		);
	}
}

/** Assemble the query: user query unaltered, then appended qualifiers. */
export function buildSearchQuery(
	operation: SearchOperation,
	target: SearchTarget,
	scope: string | undefined,
	now: Date = new Date(),
): string {
	const parts: string[] = [target.query];
	if (operation === "search_issues") parts.push("is:issue");
	if (operation === "search_prs") parts.push("is:pr");
	if (scope) parts.push(`repo:${scope}`);
	assertSearchDatesAllowed(operation, target);
	if (target.since || target.until) {
		const field = dateFieldName(operation, target.dateField);
		if (target.since) {
			parts.push(`${field}:>=${parseSearchDate(target.since, "since", now)}`);
		}
		if (target.until) {
			parts.push(`${field}:<=${parseSearchDate(target.until, "until", now)}`);
		}
	}
	return parts.join(" ");
}

/** `gh api <search endpoint>?q=<encoded>&per_page=<limit> [-H ...]`. */
export function searchApiArgs(
	operation: SearchOperation,
	query: string,
	limit: number,
	headers: string[] = [],
): string[] {
	const url = `${SEARCH_ENDPOINTS[operation]}?q=${encodeURIComponent(query)}&per_page=${limit}`;
	return ["api", url, ...headers];
}

/** Classify a failed search request into the stable taxonomy (§49, §90). */
function classifySearchFailure(
	operation: SearchOperation,
	result: RunResult,
): PiOmpGitError {
	const stderr = result.stderr.toLowerCase();
	if (
		/not authenticated|bad credentials|authentication|auth login/.test(stderr)
	) {
		return new AuthenticationError();
	}
	if (/rate limit/i.test(stderr)) {
		return new GithubApiError(
			"GitHub API rate limit exceeded. The limit resets after a wait; retry later.",
		);
	}
	if (/validation failed|is invalid|invalid/.test(stderr)) {
		const details = sanitizeStderr(result);
		return new PiOmpGitError(
			details
				? `GitHub rejected the search query: ${details}`
				: "GitHub rejected the search query.",
		);
	}
	const details = sanitizeStderr(result);
	return new GithubApiError(
		details
			? `GitHub ${SEARCH_LABELS[operation]} search failed: ${details}`
			: `GitHub ${SEARCH_LABELS[operation]} search failed with exit code ${result.exitCode ?? "signal"}`,
	);
}

interface SearchEnvelope {
	total_count: number;
	items: unknown[];
}

function parseSearchEnvelope(stdout: string): SearchEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new InvalidJsonError();
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		typeof (parsed as { total_count?: unknown }).total_count !== "number" ||
		!Array.isArray((parsed as { items?: unknown }).items)
	) {
		throw new InvalidJsonError();
	}
	return parsed as SearchEnvelope;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** `owner/repo` out of a `…/repos/owner/repo` API URL. */
function repoFromApiUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const match = /\/repos\/([^/]+)\/([^/?#]+)/.exec(url);
	return match ? `${match[1]}/${match[2]}` : undefined;
}

function isoDate(value: string | undefined): string {
	return value?.slice(0, 10) ?? "unknown";
}

function cleanFragment(fragment: unknown): string | undefined {
	if (typeof fragment !== "string") return undefined;
	const cleaned = fragment
		.replace(/<\/?em>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

/** Numbered block list: every entry ends with the canonical URL (§39). */
function renderEntries(header: string, entries: string[]): string {
	const body = entries.length ? entries.join("\n") : "No results.";
	return `${header}\n\n${body}\n`;
}

function renderIssueEntries(items: Record<string, unknown>[]): string[] {
	return items.map((item, index) => {
		const number = optionalNumber(item.number) ?? 0;
		const title = optionalString(item.title) ?? "(untitled)";
		const state = optionalString(item.state) ?? "unknown";
		const repository =
			repoFromApiUrl(optionalString(item.repository_url)) ?? "(unknown repo)";
		const author = optionalString(asRecord(item.user)?.login);
		const labels = Array.isArray(item.labels)
			? item.labels
					.flatMap((label) => {
						const name = asRecord(label)?.name;
						return typeof name === "string" && name !== "" ? [name] : [];
					})
					.join(", ")
			: "";
		const facts = [
			repository,
			author ? `author ${author}` : undefined,
			labels ? `labels ${labels}` : undefined,
			`created ${isoDate(optionalString(item.created_at))}`,
			`updated ${isoDate(optionalString(item.updated_at))}`,
		].filter((part): part is string => part !== undefined);
		return [
			`${index + 1}. #${number} [${state}] ${title}`,
			`   ${facts.join(" · ")}`,
			`   ${optionalString(item.html_url) ?? "(no URL)"}`,
		].join("\n");
	});
}

function renderCodeEntries(items: Record<string, unknown>[]): string[] {
	return items.map((item, index) => {
		const repository =
			optionalString(asRecord(item.repository)?.full_name) ?? "(unknown repo)";
		const sha = optionalString(item.sha)?.slice(0, 7);
		const matches = Array.isArray(item.text_matches) ? item.text_matches : [];
		const fragment = matches
			.map((match) => cleanFragment(asRecord(match)?.fragment))
			.find((candidate) => candidate !== undefined);
		const lines = [
			`${index + 1}. ${optionalString(item.path) ?? "(unknown path)"} (${repository}${sha ? ` @ ${sha}` : ""})`,
		];
		if (fragment) lines.push(`   ${fragment}`);
		lines.push(`   ${optionalString(item.html_url) ?? "(no URL)"}`);
		return lines.join("\n");
	});
}

function renderCommitEntries(items: Record<string, unknown>[]): string[] {
	return items.map((item, index) => {
		const sha = optionalString(item.sha)?.slice(0, 7) ?? "(unknown sha)";
		const commit = asRecord(item.commit) ?? {};
		const message = (
			(optionalString(commit.message) ?? "(no message)").split("\n", 1)[0] ??
			"(no message)"
		).trim();
		const repository =
			optionalString(asRecord(item.repository)?.full_name) ?? "(unknown repo)";
		const author =
			optionalString(asRecord(item.author)?.login) ??
			optionalString(asRecord(commit.author)?.name) ??
			"(unknown author)";
		const date = optionalString(asRecord(commit.committer)?.date) ?? "unknown";
		return [
			`${index + 1}. ${sha} ${message}`,
			`   ${repository} · ${author} · ${isoDate(date)}`,
			`   ${optionalString(item.html_url) ?? "(no URL)"}`,
		].join("\n");
	});
}

function renderRepositoryEntries(items: Record<string, unknown>[]): string[] {
	return items.map((item, index) => {
		const name = optionalString(item.full_name) ?? "(unknown repo)";
		const visibility =
			optionalString(item.visibility) ??
			(item.private === true ? "private" : "public");
		const facts = [
			optionalString(item.language),
			`stars ${optionalNumber(item.stargazers_count) ?? 0}`,
			`forks ${optionalNumber(item.forks_count) ?? 0}`,
			`open issues ${optionalNumber(item.open_issues_count) ?? 0}`,
			visibility,
		].filter((part): part is string => part !== undefined);
		const flags = [
			item.archived === true ? "archived" : undefined,
			item.fork === true ? "fork" : undefined,
		].filter((part): part is string => part !== undefined);
		const lines = [`${index + 1}. ${name}`];
		lines.push(
			`   ${[...facts, ...flags].join(" · ")} · updated ${isoDate(optionalString(item.updated_at))}`,
		);
		const description = optionalString(item.description);
		if (description) lines.push(`   ${description}`);
		lines.push(`   ${optionalString(item.html_url) ?? "(no URL)"}`);
		return lines.join("\n");
	});
}

/** Fetch and render one search operation (§34-§39). */
export async function fetchSearch(
	deps: SearchDeps,
	operation: SearchOperation,
	target: SearchTarget,
	signal?: AbortSignal,
): Promise<SearchRun> {
	const limit = parseSearchLimit(target.limit);
	assertSearchDatesAllowed(operation, target);
	// Parse (and reject bad) dates before any repo resolution or I/O.
	if (target.since) parseSearchDate(target.since, "since");
	if (target.until) parseSearchDate(target.until, "until");
	const scope = await resolveSearchScope(deps, operation, target, signal);
	const finalQuery = buildSearchQuery(operation, target, scope.scope);

	const headers =
		operation === "search_code"
			? ["-H", "Accept: application/vnd.github.text-match+json"]
			: [];
	let result: RunResult;
	try {
		result = await deps.gh.run(
			searchApiArgs(operation, finalQuery, limit, headers),
			{ signal, extraEnv: { GH_HOST: scope.host } },
		);
	} catch (error) {
		if (error instanceof CommandNotFoundError) {
			throw new DependencyError(FRIENDLY_ERRORS.ghMissing, "gh");
		}
		throw error;
	}
	if (result.exitCode !== 0) {
		throw classifySearchFailure(operation, result);
	}

	const envelope = parseSearchEnvelope(result.stdout);
	const items = envelope.items.flatMap((item) => {
		const record = asRecord(item);
		return record ? [record] : [];
	});
	const rendered = renderEntries(
		`GitHub ${SEARCH_LABELS[operation]} search — "${finalQuery}"\n${envelope.total_count} total, showing ${items.length}`,
		operation === "search_issues" || operation === "search_prs"
			? renderIssueEntries(items)
			: operation === "search_code"
				? renderCodeEntries(items)
				: operation === "search_commits"
					? renderCommitEntries(items)
					: renderRepositoryEntries(items),
	);
	return {
		totalCount: envelope.total_count,
		scope: scope.scope,
		finalQuery,
		rendered,
	};
}
