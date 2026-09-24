/**
 * The `github` dispatcher tool — one model-callable operation surface for
 * the GitHub subsystem (docs/pi-omp-git-reference.md §18). The operation
 * enum is the stable dispatcher contract; `repo_view`, `file_read`, and
 * the five searches arrive with tickets 08-09, and later tickets fill in
 * the remaining operations with clear errors until they land.
 *
 * Errors are thrown from `execute()` so Pi produces a failed tool result
 * from the message alone — no stack traces, no echoed tokens (§49).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import {
	createMutationLock,
	type RepositoryMutationLock,
} from "../git/mutation-lock.ts";
import type { GitRunner } from "../git/runner.ts";
import { PiOmpGitError } from "../shared/errors.ts";
import type { Availability } from "./availability.ts";
import type { GithubCache } from "./cache/cache.ts";
import type { CheckoutRecord } from "./last-checkout.ts";
import type { NestedModel, NestedSessionFactory } from "./nested-agent.ts";
import { fetchFileRead } from "./operations/file-read.ts";
import {
	checkoutPullRequests,
	type PrCheckoutFailure,
	type PrCheckoutItem,
	renderPrCheckout,
} from "./operations/pr-checkout.ts";
import { createPullRequest } from "./operations/pr-create.ts";
import { pushPullRequest } from "./operations/pr-push.ts";
import { fetchRepoView, renderRepoView } from "./operations/repo-view.ts";
import {
	type RunWatchDetails,
	type RunWatchRunState,
	watchActions,
} from "./operations/run-watch.ts";
import {
	fetchSearch,
	parseSearchLimit,
	type SearchOperation,
} from "./operations/search.ts";
import type { GhRunner } from "./runner.ts";

/** The full §18 operation surface; later tickets activate the rest. */
export const GITHUB_OPERATIONS = [
	"repo_view",
	"file_read",
	"pr_create",
	"pr_checkout",
	"pr_push",
	"search_issues",
	"search_prs",
	"search_code",
	"search_commits",
	"search_repos",
	"run_watch",
] as const;

export type GithubOperation = (typeof GITHUB_OPERATIONS)[number];

// TypeBox's Union loses tuple inference over a mapped array, so the
// schema lists the literals explicitly; the compile-time check below
// fails the typecheck the day the two lists drift apart.
const OPERATION_SCHEMA = Type.Union([
	Type.Literal("repo_view"),
	Type.Literal("file_read"),
	Type.Literal("pr_create"),
	Type.Literal("pr_checkout"),
	Type.Literal("pr_push"),
	Type.Literal("search_issues"),
	Type.Literal("search_prs"),
	Type.Literal("search_code"),
	Type.Literal("search_commits"),
	Type.Literal("search_repos"),
	Type.Literal("run_watch"),
]);
type SchemaOperations = Static<typeof OPERATION_SCHEMA>;
type AssertSchemaOperationsMatch = SchemaOperations extends GithubOperation
	? GithubOperation extends SchemaOperations
		? true
		: never
	: never;
const _schemaOperationsMatch: AssertSchemaOperationsMatch = true;
void _schemaOperationsMatch;

/** The operations served by the §34 search module. */
export const SEARCH_OPERATIONS = [
	"search_issues",
	"search_prs",
	"search_code",
	"search_commits",
	"search_repos",
] as const;

export const GithubToolParams = Type.Object({
	op: OPERATION_SCHEMA,
	repo: Type.Optional(
		Type.String({
			description:
				"Repository as owner/repo or host/owner/repo (Enterprise). Omit to use the current checkout's repository.",
		}),
	),
	branch: Type.Optional(
		Type.String({
			description:
				"Branch, tag, or commit ref. Defaults to the repository's default branch.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description:
				"Repository-relative file path (for file_read), e.g. src/index.ts.",
		}),
	),
	query: Type.Optional(
		Type.String({
			description:
				"GitHub search query (search_* operations). GitHub query syntax reaches the API unaltered, e.g. 'is:open label:bug in:title'.",
		}),
	),
	since: Type.Optional(
		Type.String({
			description:
				"Lower date bound for searches: relative units (3m, 12h, 7d, 2w, 3mo, 1y) or YYYY-MM-DD / ISO-8601. Rejected by search_code.",
		}),
	),
	until: Type.Optional(
		Type.String({
			description:
				"Upper date bound for searches: relative units (3m, 12h, 7d, 2w, 3mo, 1y) or YYYY-MM-DD / ISO-8601. Rejected by search_code.",
		}),
	),
	dateField: Type.Optional(
		Type.Union([Type.Literal("created"), Type.Literal("updated")], {
			description:
				"Which timestamp since/until filter (default created). Commits always use committer-date; repository 'updated' maps to push time.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description:
				"Maximum results (search_* operations). Default 10, maximum 50.",
		}),
	),
	title: Type.Optional(
		Type.String({
			description: "PR title (pr_create). Mutually exclusive with fill.",
		}),
	),
	body: Type.Optional(
		Type.String({
			description:
				"PR body (pr_create). Empty string is valid; a nonempty body travels through a temporary file.",
		}),
	),
	base: Type.Optional(
		Type.String({
			description:
				"Target base branch (pr_create). Defaults to gh's inference.",
		}),
	),
	head: Type.Optional(
		Type.String({
			description: "Head branch (pr_create). Defaults to the current branch.",
		}),
	),
	draft: Type.Optional(
		Type.Boolean({ description: "Create the PR as a draft (pr_create)." }),
	),
	fill: Type.Optional(
		Type.Boolean({
			description:
				"Generate title and body from the change via a nested agent session (pr_create). Mutually exclusive with title and body.",
		}),
	),
	reviewer: Type.Optional(
		Type.Array(Type.String(), {
			description: "Requested reviewers (pr_create).",
		}),
	),
	assignee: Type.Optional(
		Type.Array(Type.String(), {
			description: "Requested assignees (pr_create).",
		}),
	),
	label: Type.Optional(
		Type.Array(Type.String(), { description: "Labels to apply (pr_create)." }),
	),
	pr: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description:
				"PR identifier for pr_checkout/pr_push: a number as a string, a PR URL, or a branch-like identifier. Arrays batch pr_checkout only. JSON numbers are rejected.",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description:
				"pr_checkout: reset an existing wrong-SHA pr-N branch to the PR head (D2). Never a silent reset without it.",
		}),
	),
	forceWithLease: Type.Optional(
		Type.Boolean({
			description:
				"pr_push: push with --force-with-lease. Plain --force does not exist in this surface.",
		}),
	),
	run: Type.Optional(
		Type.String({
			description:
				"run_watch: Actions run ID or run URL. Omit for commit mode.",
		}),
	),
	commit: Type.Optional(
		Type.String({
			description:
				"run_watch commit mode: commit SHA. Defaults to the last checkout's head SHA, then current HEAD.",
		}),
	),
	tail: Type.Optional(
		Type.Number({
			description:
				"run_watch: inline log-tail lines for failed jobs (default 15, max 200).",
		}),
	),
});

export type GithubToolArguments = Static<typeof GithubToolParams>;

export interface GithubToolDetails {
	op?: string;
	repo?: string;
	branch?: string;
	path?: string;
	kind?: string;
	truncated?: boolean;
	/** Search: the effective query sent to the API (qualifiers appended). */
	query?: string;
	/** Search: the effective result cap. */
	limit?: number;
	/** Search: the GitHub-reported total before the limit. */
	total?: number;
	/** pr_create/pr_push: the canonical PR URL and number, when known. */
	url?: string;
	number?: number;
	/** pr_checkout: the managed worktree path (prominent, §110). */
	worktreePath?: string;
	/** pr_checkout: the local pr-N branch. */
	prBranch?: string;
	/** pr_checkout: an existing checkout was reused rather than created. */
	reused?: boolean;
	/** pr_checkout: all successful checkouts (batch carries every one). */
	checkouts?: PrCheckoutItem[];
	/** pr_checkout: structured per-PR failures (§24, D4). */
	failures?: PrCheckoutFailure[];
	/** pr_push: how the target resolved (§110). */
	resolvedBy?: string;
	/** pr_push: the remote the branch was pushed to. */
	pushRemote?: string;
	/** run_watch: the watched run ID (run mode). */
	runId?: number;
	/** run_watch: the watched commit SHA (commit mode). */
	commitSha?: string;
	/** run_watch: final outcome classification. */
	outcome?: "success" | "failure" | "no-runs";
	/** run_watch: elapsed watch seconds. */
	elapsedSeconds?: number;
	/** run_watch: per-run state with jobs, log tails, artifact paths. */
	runs?: RunWatchRunState[];
}

/** The slice of Pi's tool context the dispatcher consumes. */
export interface GithubToolContext {
	/** The parent session's model (nested agents inherit it, §75). */
	model?: NestedModel;
	/** The session's working directory (nested agents run there). */
	cwd?: string;
	/** The session's most recent pr_checkout record (§110 resolution). */
	getLastCheckout?: () => CheckoutRecord | null;
}

export interface GithubToolDeps {
	gh: GhRunner;
	git: GitRunner;
	availability: Availability;
	env: NodeJS.ProcessEnv;
	/** Test seam for the nested agent session factory (§75). */
	createNestedSession?: NestedSessionFactory;
	/** Body-file directory override (tests inject a stable path). */
	tempDir?: string;
	/** Cache rows invalidated after confirmed mutations (§33, §57). */
	cache?: GithubCache;
	/** Absolute managed-worktree root (config-resolved, §26). */
	getWorktreeRoot?: () => string;
	/** Absolute root for captured Actions log artifacts (§44). */
	getArtifactsRoot?: () => string;
	/** Injected time for run_watch polling (tests, §98). */
	clock?: import("./operations/run-watch.ts").WatchClock;
	/** Shared-repository mutation lock (§31); a fresh lock by default. */
	mutationLock?: RepositoryMutationLock;
}

export interface GithubTool {
	name: "github";
	label: string;
	description: string;
	parameters: typeof GithubToolParams;
	execute(
		toolCallId: string,
		params: GithubToolArguments,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GithubToolDetails>,
		ctx?: GithubToolContext,
	): Promise<AgentToolResult<GithubToolDetails>>;
}

const TOOL_DESCRIPTION = `GitHub operations through one dispatcher. Uses the authenticated GitHub CLI; no separate token setup.

Operations:
- repo_view: repository metadata (description, URL, default branch, visibility, permission, language, stars, forks, archived/fork status, topics).
- file_read: a file from a GitHub repository — text decoded, images returned as image content, other binaries as metadata with the GitHub source URL.
- pr_create: create a pull request with an explicit title, or fill: true to generate title and body from the change via a nested agent session.
- pr_checkout: check one PR (or a batch) out into dedicated managed worktrees — never touching the current checkout; the result's worktreePath is where edits happen via absolute paths.
- pr_push: push a pr_checkout-prepared branch back to its PR; resolves by explicit pr/branch, the session's last checkout, or current-branch metadata.
- search_issues / search_prs / search_code / search_commits / search_repos: GitHub searches — GitHub query syntax reaches the API unaltered; results render agent-useful fields with canonical URLs. Issues/PRs/code/commits scope to the current checkout unless the query already declares repo:/org:/user:/owner: scope.
- run_watch: watch GitHub Actions — a specific run (run ID or run URL) or every workflow run for a commit (explicit commit/pr, else the session's last checkout, else current HEAD). Failed jobs surface with inline log tails and full-log artifact paths; progress streams while polling.

Use repo_view to orient in an unfamiliar repository, file_read instead of curl/wget for files stored in GitHub repositories, and the search_* operations instead of scraping pages. After pr_checkout, edit files under the returned worktree path using absolute paths.`;

/** The dispatcher's own validation error for malformed tool parameters. */
export class GithubParamsError extends PiOmpGitError {}

/** Validate the dispatcher's operation enum and parameter shapes (§18). */
export function validateGithubArguments(params: unknown): GithubToolArguments {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new GithubParamsError(
			"The github tool requires a parameters object with an `op` field.",
		);
	}
	const record = params as Record<string, unknown>;
	const op = record.op;
	if (
		typeof op !== "string" ||
		!GITHUB_OPERATIONS.includes(op as GithubOperation)
	) {
		throw new GithubParamsError(
			`Unknown github operation: ${JSON.stringify(op)}. Valid operations: ${GITHUB_OPERATIONS.join(", ")}.`,
		);
	}
	const operation = op as GithubOperation;
	const validated: GithubToolArguments = { op: operation };
	for (const field of [
		"repo",
		"branch",
		"path",
		"query",
		"since",
		"until",
		"title",
		"base",
		"head",
		"run",
		"commit",
	] as const) {
		const value = record[field];
		if (value === undefined || value === null) continue;
		if (typeof value !== "string" || value.trim() === "") {
			throw new GithubParamsError(
				`The \`${field}\` parameter must be a non-empty string.`,
			);
		}
		validated[field] = value;
	}
	const dateField = record.dateField;
	if (dateField !== undefined && dateField !== null) {
		if (dateField !== "created" && dateField !== "updated") {
			throw new GithubParamsError(
				'The `dateField` parameter must be "created" or "updated".',
			);
		}
		validated.dateField = dateField;
	}
	if (record.limit !== undefined && record.limit !== null) {
		if (typeof record.limit !== "number") {
			throw new GithubParamsError(
				"The `limit` parameter must be a number between 1 and 50.",
			);
		}
		validated.limit = record.limit;
	}
	// pr_create's body may be explicitly empty (noninteractive, §22) —
	// type-checked but not emptiness-checked.
	if (record.body !== undefined && record.body !== null) {
		if (typeof record.body !== "string") {
			throw new GithubParamsError(
				"The `body` parameter must be a string (empty is allowed).",
			);
		}
		validated.body = record.body;
	}
	for (const field of ["draft", "fill"] as const) {
		const value = record[field];
		if (value === undefined || value === null) continue;
		if (typeof value !== "boolean") {
			throw new GithubParamsError(
				`The \`${field}\` parameter must be a boolean.`,
			);
		}
		validated[field] = value;
	}
	for (const field of ["force", "forceWithLease"] as const) {
		const value = record[field];
		if (value === undefined || value === null) continue;
		if (typeof value !== "boolean") {
			throw new GithubParamsError(
				`The \`${field}\` parameter must be a boolean.`,
			);
		}
		validated[field] = value;
	}
	// §44: the run_watch log tail is a number of lines.
	const tailValue = record.tail;
	if (tailValue !== undefined && tailValue !== null) {
		if (typeof tailValue !== "number") {
			throw new GithubParamsError(
				"The `tail` parameter must be a positive number of log lines (max 200).",
			);
		}
		validated.tail = tailValue;
	}
	// §24: `pr` values are text — a number as a string, a PR URL, or a
	// branch-like identifier. JSON numbers are rejected outright.
	const prValue = record.pr;
	if (prValue !== undefined && prValue !== null) {
		if (typeof prValue === "number") {
			throw new GithubParamsError(
				"The `pr` parameter must be text — a PR number as a string, a PR URL, or a branch-like identifier. JSON numbers are rejected.",
			);
		}
		if (typeof prValue === "string") {
			if (prValue.trim() === "") {
				throw new GithubParamsError(
					"The `pr` parameter must be a non-empty string.",
				);
			}
			validated.pr = prValue;
		} else if (Array.isArray(prValue)) {
			if (prValue.length === 0) {
				throw new GithubParamsError("The `pr` array must not be empty.");
			}
			if (
				prValue.some((item) => typeof item !== "string" || item.trim() === "")
			) {
				throw new GithubParamsError(
					"The `pr` array must contain non-empty strings.",
				);
			}
			validated.pr = prValue as string[];
		} else {
			throw new GithubParamsError(
				"The `pr` parameter must be a string or an array of strings.",
			);
		}
	}
	for (const field of ["reviewer", "assignee", "label"] as const) {
		const value = record[field];
		if (value === undefined || value === null) continue;
		if (
			!Array.isArray(value) ||
			value.some((item) => typeof item !== "string" || item.trim() === "")
		) {
			throw new GithubParamsError(
				`The \`${field}\` parameter must be an array of non-empty strings.`,
			);
		}
		validated[field] = value;
	}
	if (
		SEARCH_OPERATIONS.includes(
			operation as (typeof SEARCH_OPERATIONS)[number],
		) &&
		(!validated.query || validated.query.trim() === "")
	) {
		throw new GithubParamsError(
			`The \`${operation}\` operation requires a non-empty \`query\` parameter.`,
		);
	}
	// §24: pr_checkout requires `pr` (single or batch array).
	if (operation === "pr_checkout" && validated.pr === undefined) {
		throw new GithubParamsError(
			"The `pr_checkout` operation requires the `pr` parameter — a PR number as a string, a PR URL, or a branch-like identifier.",
		);
	}
	// §110: pr_push and run_watch accept a single PR; arrays are
	// pr_checkout batching alone.
	if (
		(operation === "pr_push" || operation === "run_watch") &&
		Array.isArray(validated.pr)
	) {
		throw new GithubParamsError(
			`${operation} accepts a single PR; the array form of \`pr\` is valid for pr_checkout batching only.`,
		);
	}
	// §40: run mode and commit mode are mutually exclusive.
	if (
		operation === "run_watch" &&
		typeof validated.run === "string" &&
		(typeof validated.commit === "string" || typeof validated.pr === "string")
	) {
		throw new GithubParamsError(
			"run_watch accepts either `run` (run mode) or `commit`/`pr` (commit mode), not both.",
		);
	}
	// §44: the log tail is a bounded line count.
	if (validated.tail !== undefined) {
		const tail = validated.tail;
		if (typeof tail !== "number" || !Number.isFinite(tail) || tail <= 0) {
			throw new GithubParamsError(
				"The `tail` parameter must be a positive number of log lines (max 200).",
			);
		}
		validated.tail = Math.min(200, Math.floor(tail));
	}
	return validated;
}

/** Execute one dispatcher operation. */
export async function executeGithubOperation(
	deps: GithubToolDeps,
	params: GithubToolArguments,
	signal?: AbortSignal,
	ctx?: GithubToolContext,
	onUpdate?: AgentToolUpdateCallback<GithubToolDetails>,
): Promise<{
	content: AgentToolResult<GithubToolDetails>["content"];
	details: GithubToolDetails;
}> {
	// Dependency gating: the friendly unavailability/authentication errors
	// come from the memoized probe, not a raw spawn failure (§4, §49).
	await deps.availability.ensureGh();
	switch (params.op) {
		case "repo_view": {
			const view = await fetchRepoView(
				deps.gh,
				{ repo: params.repo, branch: params.branch },
				signal,
			);
			return {
				content: [{ type: "text", text: renderRepoView(view, params.branch) }],
				details: {
					op: "repo_view",
					repo: params.repo ?? view.nameWithOwner,
					branch: params.branch,
				},
			};
		}
		case "file_read": {
			const result = await fetchFileRead(
				deps,
				{ repo: params.repo, branch: params.branch, path: params.path ?? "" },
				signal,
			);
			const details: GithubToolDetails = {
				op: "file_read",
				repo: params.repo,
				branch: params.branch,
				path: params.path,
				kind: result.kind,
			};
			if (result.kind === "image" && result.image) {
				return {
					content: [
						{
							type: "image",
							data: result.image.data,
							mimeType: result.image.mimeType,
						},
					],
					details,
				};
			}
			if (result.kind === "binary" && result.metadata) {
				return {
					content: [{ type: "text", text: result.metadata }],
					details,
				};
			}
			return {
				content: [{ type: "text", text: result.text ?? "" }],
				details: {
					...details,
					...(result.truncated ? { truncated: true } : {}),
				},
			};
		}
		case "pr_create": {
			const created = await createPullRequest(
				{
					gh: deps.gh,
					git: deps.git,
					cwd: ctx?.cwd ?? process.cwd(),
					model: ctx?.model,
					createNestedSession: deps.createNestedSession,
					tempDir: deps.tempDir,
				},
				{
					repo: params.repo,
					title: params.title,
					body: params.body,
					base: params.base,
					head: params.head,
					draft: params.draft,
					fill: params.fill,
					reviewer: params.reviewer,
					assignee: params.assignee,
					label: params.label,
				},
				signal,
			);
			return {
				content: [{ type: "text", text: created.summary }],
				details: {
					op: "pr_create",
					repo: params.repo,
					url: created.url,
					number: created.number,
				},
			};
		}

		case "pr_checkout": {
			await deps.availability.ensureGit();
			const outcome = await checkoutPullRequests(
				{
					gh: deps.gh,
					git: deps.git,
					env: deps.env,
					cwd: ctx?.cwd,
					getWorktreeRoot:
						deps.getWorktreeRoot ??
						(() => join(homedir(), ".pi", "agent", "worktrees")),
					mutationLock: deps.mutationLock ?? createMutationLock(),
				},
				{
					pr: params.pr ?? "",
					force: params.force,
					repo: params.repo,
				},
				signal,
			);
			const single = outcome.checkouts[0];
			return {
				content: [{ type: "text", text: renderPrCheckout(outcome) }],
				details: {
					op: "pr_checkout",
					repo: params.repo,
					...(single
						? {
								number: single.number,
								url: single.url,
								prBranch: single.branch,
								worktreePath: single.worktreePath,
								reused: single.reused,
							}
						: {}),
					checkouts: outcome.checkouts,
					failures: outcome.failures,
				},
			};
		}

		case "pr_push": {
			await deps.availability.ensureGit();
			const pushed = await pushPullRequest(
				{
					gh: deps.gh,
					git: deps.git,
					cwd: ctx?.cwd,
					cache: deps.cache,
					getLastCheckout: ctx?.getLastCheckout,
				},
				{
					pr: typeof params.pr === "string" ? params.pr : undefined,
					branch: params.branch,
					forceWithLease: params.forceWithLease,
				},
				signal,
			);
			return {
				content: [{ type: "text", text: pushed.summary }],
				details: {
					op: "pr_push",
					branch: pushed.branch,
					url: pushed.url,
					number: pushed.number,
					resolvedBy: pushed.resolvedBy,
					pushRemote: pushed.pushRemote,
				},
			};
		}

		case "run_watch": {
			const watch = await watchActions(
				{
					gh: deps.gh,
					git: deps.git,
					env: deps.env,
					cwd: ctx?.cwd ?? process.cwd(),
					getLastCheckout: ctx?.getLastCheckout,
					artifactsDir: deps.getArtifactsRoot?.(),
					clock: deps.clock,
					signal,
					onUpdate: (update: RunWatchDetails) => {
						onUpdate?.({
							content: [],
							details: {
								op: "run_watch",
								repo: update.repo,
								...(update.run !== undefined ? { runId: update.run } : {}),
								...(update.commit !== undefined
									? { commitSha: update.commit }
									: {}),
								...(update.status !== undefined
									? { status: update.status }
									: {}),
								...(update.elapsedSeconds !== undefined
									? { elapsedSeconds: update.elapsedSeconds }
									: {}),
								...(update.runs !== undefined ? { runs: update.runs } : {}),
							},
						});
					},
				},
				{
					run: params.run,
					commit: params.commit,
					pr: typeof params.pr === "string" ? params.pr : undefined,
					repo: params.repo,
					tail: params.tail,
				},
			);
			const watchDetails: GithubToolDetails = {
				op: "run_watch",
				repo: watch.details.repo,
				...(watch.details.run !== undefined
					? { runId: watch.details.run }
					: {}),
				...(watch.details.commit !== undefined
					? { commitSha: watch.details.commit }
					: {}),
				outcome: watch.details.outcome,
				elapsedSeconds: watch.details.elapsedSeconds,
				runs: watch.details.runs,
			};
			return {
				content: [{ type: "text", text: watch.text }],
				details: watchDetails,
			};
		}

		default: {
			if (!(SEARCH_OPERATIONS as readonly string[]).includes(params.op)) {
				throw new GithubParamsError(
					`github operation "${params.op}" is not available in this build of pi-omp-git yet.`,
				);
			}
			// search_*: GitHub query syntax reaches the API unaltered (§34).
			const run = await fetchSearch(
				deps,
				params.op as SearchOperation,
				{
					repo: params.repo,
					query: params.query ?? "",
					since: params.since,
					until: params.until,
					dateField: params.dateField,
					limit: params.limit,
				},
				signal,
			);
			return {
				content: [{ type: "text", text: run.rendered }],
				details: {
					op: params.op,
					repo: run.scope,
					query: run.finalQuery,
					limit: parseSearchLimit(params.limit),
					total: run.totalCount,
				},
			};
		}
	}
}

/** Build the `github` dispatcher tool for registration with Pi. */
export function createGithubTool(deps: GithubToolDeps): GithubTool {
	return {
		name: "github",
		label: "github",
		description: TOOL_DESCRIPTION,
		parameters: GithubToolParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const validated = validateGithubArguments(params);
			return executeGithubOperation(deps, validated, signal, ctx, onUpdate);
		},
	};
}
