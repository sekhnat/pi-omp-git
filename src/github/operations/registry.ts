import { join } from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
	createMutationLock,
	type RepositoryMutationLock,
} from "../../git/mutation-lock.ts";
import type { GitRunner } from "../../git/runner.ts";
import type { Availability } from "../availability.ts";
import type { GithubCache } from "../cache/cache.ts";
import type { GithubToolDetails } from "../dispatcher.ts";
import type { CheckoutRecord } from "../last-checkout.ts";
import type { NestedModel, NestedSessionFactory } from "../nested-agent.ts";
import type { GhRunner } from "../runner.ts";
import {
	FILE_READ_OPERATION_PARAMETERS,
	type FileReadOperationArguments,
	fetchFileRead,
	validateFileReadOperationArguments,
} from "./file-read.ts";
import {
	checkoutPullRequests,
	PR_CHECKOUT_OPERATION_PARAMETERS,
	type PrCheckoutOperationArguments,
	renderPrCheckout,
	validatePrCheckoutOperationArguments,
} from "./pr-checkout.ts";
import {
	createPullRequest,
	PR_CREATE_OPERATION_PARAMETERS,
	type PrCreateOperationArguments,
	validatePrCreateOperationArguments,
} from "./pr-create.ts";
import {
	PR_PUSH_OPERATION_PARAMETERS,
	type PrPushOperationArguments,
	pushPullRequest,
	validatePrPushOperationArguments,
} from "./pr-push.ts";
import {
	fetchRepoView,
	REPO_VIEW_OPERATION_PARAMETERS,
	type RepoViewOperationArguments,
	renderRepoView,
	validateRepoViewOperationArguments,
} from "./repo-view.ts";
import {
	RUN_WATCH_OPERATION_PARAMETERS,
	type RunWatchOperationArguments,
	validateRunWatchOperationArguments,
	type WatchClock,
	watchActions,
} from "./run-watch.ts";
import {
	fetchSearch,
	parseSearchLimit,
	type SearchOperation,
	type SearchOperationArguments,
	searchOperationParameters,
	validateSearchOperationArguments,
} from "./search.ts";

export interface GithubOperationContext {
	gh: GhRunner;
	git: GitRunner;
	env: NodeJS.ProcessEnv;
	availability: Availability;
	cwd?: string;
	model?: NestedModel;
	createNestedSession?: NestedSessionFactory;
	tempDir?: string;
	cache?: GithubCache;
	getWorktreeRoot?: () => string;
	getLastCheckout?: () => CheckoutRecord | null;
	mutationLock?: RepositoryMutationLock;
	getArtifactsRoot?: () => string;
	clock?: WatchClock;
}

export interface GithubOperationResult {
	content: AgentToolResult<GithubToolDetails>["content"];
	details: GithubToolDetails;
}

type OperationArguments = { op: string } & object;
type OperationUpdate = AgentToolUpdateCallback<GithubToolDetails>;

interface RegisteredOperation {
	parameters: TSchema;
	validate(params: Record<string, unknown>): OperationArguments;
	execute(
		context: GithubOperationContext,
		params: OperationArguments,
		signal?: AbortSignal,
		onUpdate?: OperationUpdate,
	): Promise<GithubOperationResult>;
}

function defineOperation<Arguments extends { op: string }>(
	parameters: TSchema,
	validate: (params: Record<string, unknown>) => Arguments,
	execute: (
		context: GithubOperationContext,
		params: Arguments,
		signal?: AbortSignal,
		onUpdate?: OperationUpdate,
	) => Promise<GithubOperationResult>,
): RegisteredOperation {
	return {
		parameters,
		validate,
		execute: (context, params, signal, onUpdate) =>
			execute(context, params as Arguments, signal, onUpdate),
	};
}

function searchOperation<Operation extends SearchOperation>(
	operation: Operation,
): RegisteredOperation {
	return defineOperation<SearchOperationArguments<Operation>>(
		searchOperationParameters(operation),
		(params) => validateSearchOperationArguments(operation, params),
		async (context, params, signal) => {
			const run = await fetchSearch(
				context,
				operation,
				{
					repo: params.repo,
					query: params.query,
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
					op: operation,
					repo: run.scope,
					query: run.finalQuery,
					limit: parseSearchLimit(params.limit),
					total: run.totalCount,
				},
			};
		},
	);
}

export const GITHUB_OPERATION_REGISTRY = {
	repo_view: defineOperation<RepoViewOperationArguments>(
		REPO_VIEW_OPERATION_PARAMETERS,
		validateRepoViewOperationArguments,
		async (context, params, signal) => {
			const view = await fetchRepoView(
				context.gh,
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
		},
	),
	file_read: defineOperation<FileReadOperationArguments>(
		FILE_READ_OPERATION_PARAMETERS,
		validateFileReadOperationArguments,
		async (context, params, signal) => {
			const result = await fetchFileRead(
				context,
				{
					repo: params.repo,
					branch: params.branch,
					path: params.path ?? "",
				},
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
		},
	),
	pr_create: defineOperation<PrCreateOperationArguments>(
		PR_CREATE_OPERATION_PARAMETERS,
		validatePrCreateOperationArguments,
		async (context, params, signal) => {
			const created = await createPullRequest(
				{
					gh: context.gh,
					git: context.git,
					cwd: context.cwd ?? process.cwd(),
					model: context.model,
					createNestedSession: context.createNestedSession,
					tempDir: context.tempDir,
				},
				params,
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
		},
	),
	pr_checkout: defineOperation<PrCheckoutOperationArguments>(
		PR_CHECKOUT_OPERATION_PARAMETERS,
		validatePrCheckoutOperationArguments,
		async (context, params, signal) => {
			await context.availability.ensureGit();
			const outcome = await checkoutPullRequests(
				{
					gh: context.gh,
					git: context.git,
					env: context.env,
					cwd: context.cwd,
					getWorktreeRoot:
						context.getWorktreeRoot ?? (() => join(getAgentDir(), "worktrees")),
					mutationLock: context.mutationLock ?? createMutationLock(),
				},
				params,
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
		},
	),
	pr_push: defineOperation<PrPushOperationArguments>(
		PR_PUSH_OPERATION_PARAMETERS,
		validatePrPushOperationArguments,
		async (context, params, signal) => {
			await context.availability.ensureGit();
			const pushed = await pushPullRequest(
				{
					gh: context.gh,
					git: context.git,
					cwd: context.cwd,
					cache: context.cache,
					getLastCheckout: context.getLastCheckout,
				},
				params,
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
		},
	),
	search_issues: searchOperation("search_issues"),
	search_prs: searchOperation("search_prs"),
	search_code: searchOperation("search_code"),
	search_commits: searchOperation("search_commits"),
	search_repos: searchOperation("search_repos"),
	run_watch: defineOperation<RunWatchOperationArguments>(
		RUN_WATCH_OPERATION_PARAMETERS,
		validateRunWatchOperationArguments,
		async (context, params, signal, onUpdate) => {
			const watch = await watchActions(
				{
					gh: context.gh,
					git: context.git,
					env: context.env,
					cwd: context.cwd ?? process.cwd(),
					getLastCheckout: context.getLastCheckout,
					artifactsDir: context.getArtifactsRoot?.(),
					clock: context.clock,
					signal,
					onUpdate: (update) => {
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
					pr: params.pr,
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
		},
	),
} satisfies Record<
	| "repo_view"
	| "file_read"
	| "pr_create"
	| "pr_checkout"
	| "pr_push"
	| "run_watch"
	| SearchOperation,
	RegisteredOperation
>;

export type RegisteredGithubOperation = keyof typeof GITHUB_OPERATION_REGISTRY;

export function isRegisteredGithubOperation(
	operation: string,
): operation is RegisteredGithubOperation {
	return Object.hasOwn(GITHUB_OPERATION_REGISTRY, operation);
}

/** Operation-owned argument validation, merged into the stable tool envelope. */
export function validateRegisteredOperation(
	operation: string,
	params: Record<string, unknown>,
): OperationArguments | undefined {
	if (!isRegisteredGithubOperation(operation)) return undefined;
	return GITHUB_OPERATION_REGISTRY[operation].validate(params);
}

/** Execute a registered operation; other operation groups remain in dispatcher. */
export async function executeRegisteredOperation(
	operation: string,
	context: GithubOperationContext,
	params: object,
	signal?: AbortSignal,
	onUpdate?: OperationUpdate,
): Promise<GithubOperationResult | undefined> {
	if (!isRegisteredGithubOperation(operation)) return undefined;
	const record = params as Record<string, unknown>;
	const definition = GITHUB_OPERATION_REGISTRY[operation];
	return definition.execute(
		context,
		definition.validate(record),
		signal,
		onUpdate,
	);
}
