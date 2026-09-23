/**
 * The `read` override — tickets 02–07 (docs/pi-omp-git-reference.md §7).
 *
 * `issue://` and `pr://` scheme URIs route to the GitHub resource
 * machinery; everything else delegates to Pi's native read with zero
 * behavior change. The result shape (content blocks + ReadToolDetails)
 * matches the native read, so pagination discipline carries over.
 * PR diff resources are implemented in tickets 05–06; ticket 07 adds live,
 * uncached issue and PR listing resources.
 *
 * Since ticket 03, single-issue reads flow through the cache facade:
 * fresh rows are served without a second `gh` invocation, the soft/hard
 * TTL bands apply, and bare-form reads resolve the current repository
 * locally (never a network call) so cache rows can be scoped by repo.
 * Issue fetches retain a bare command for checkout-resolved resources; PR
 * and diff fetches pass explicit owner/repo, while the resolved identity
 * scopes every cache row.
 */

import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	ReadToolDetails,
	TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { GitRunner } from "../../git/runner.ts";
import type { ResolvedConfig } from "../../shared/config.ts";
import type { Availability } from "../availability.ts";
import { credentialFingerprint } from "../cache/auth-key.ts";
import { createGithubCache, type GithubCache } from "../cache/cache.ts";
import { openCacheStore } from "../cache/db.ts";
import { resolveCurrentGithubRepo } from "../repo.ts";
import type { GhRunner } from "../runner.ts";
import {
	fetchPrDiff,
	PR_DIFF_UPDATED_NOTICE,
	parseCachedPrDiff,
	renderPrDiff,
} from "./diffs.ts";
import { fetchIssue } from "./issues.ts";
import { fetchIssueList, fetchPullRequestList } from "./lists.ts";
import { type GithubResource, parseGithubUri } from "./parser.ts";
import { fetchPullRequest } from "./prs.ts";

import {
	paginateRendered,
	renderIssue,
	renderIssueList,
	renderPullRequest,
	renderPullRequestList,
} from "./render.ts";
export type NativeReadResult = AgentToolResult<ReadToolDetails | undefined>;

export interface ReadToolParams {
	path: string;
	offset?: number;
	limit?: number;
}

/** Structural shape of Pi's native read tool instance we delegate to. */
export interface NativeReadTool {
	execute(
		toolCallId: string,
		params: ReadToolParams,
		signal?: AbortSignal,
		onUpdate?: unknown,
	): Promise<NativeReadResult>;
}

export type GithubReadResult = AgentToolResult<ReadToolDetails | undefined>;

export interface GithubReadOverride {
	execute(
		toolCallId: string,
		params: ReadToolParams,
		signal?: AbortSignal,
		onUpdate?: unknown,
	): Promise<GithubReadResult | NativeReadResult>;
}

export interface GithubReadDeps {
	gh: GhRunner;
	git: GitRunner;
	availability: Availability;
	cache: GithubCache;
	env: NodeJS.ProcessEnv;
	getConfig: () => ResolvedConfig;
	nativeRead: NativeReadTool;
}

export interface RenderedResource {
	text: string;
	details: { truncation: TruncationResult };
}

export function isGithubResourceUri(path: string): boolean {
	return /^(issue|pr):\/\//i.test(path);
}

/** Route + fetch + render + paginate one virtual GitHub resource. */
export async function readGithubResource(
	deps: GithubReadDeps,
	resource: GithubResource,
	request: { offset?: number; limit?: number },
	signal?: AbortSignal,
	versionState?: Map<string, string>,
): Promise<RenderedResource> {
	switch (resource.kind) {
		case "issue": {
			await deps.availability.ensureGh();
			const identity = await resolveResourceIdentity(deps, resource, signal);
			const live = async (): Promise<string> => {
				const issue = await fetchIssue(
					deps.gh,
					{
						host: resource.host,
						owner: resource.owner,
						repo: resource.repo,
						number: resource.number,
						comments: resource.comments,
					},
					signal,
				);
				return renderIssue(issue, { comments: resource.comments });
			};
			const outcome = await deps.cache.readThrough(
				{
					kind: "issue",
					host: identity.host,
					owner: identity.owner,
					repo: identity.repo,
					number: resource.number,
					includeComments: resource.comments,
				},
				live,
				signal,
			);
			const text = outcome.staleNotice
				? `${outcome.staleNotice}\n${outcome.text}`
				: outcome.text;
			return paginateRendered(text, request.offset, request.limit);
		}
		case "pr": {
			await deps.availability.ensureGh();
			const identity = await resolveResourceIdentity(deps, resource, signal);
			const live = async (): Promise<string> => {
				const pull = await fetchPullRequest(
					deps.gh,
					{
						host: resource.host,
						owner: identity.owner,
						repo: identity.repo,
						number: resource.number,
						comments: resource.comments,
					},
					signal,
				);
				return renderPullRequest(pull, { comments: resource.comments });
			};
			const outcome = await deps.cache.readThrough(
				{
					kind: "pr",
					host: identity.host,
					owner: identity.owner,
					repo: identity.repo,
					number: resource.number,
					includeComments: resource.comments,
				},
				live,
				signal,
			);
			const text = outcome.staleNotice
				? `${outcome.staleNotice}\n${outcome.text}`
				: outcome.text;
			return paginateRendered(text, request.offset, request.limit);
		}
		case "pr-diff": {
			await deps.availability.ensureGh();
			const identity = await resolveResourceIdentity(deps, resource, signal);
			const cacheIdentity = {
				kind: "pr-diff" as const,
				host: identity.host,
				owner: identity.owner,
				repo: identity.repo,
				number: resource.number,
				includeComments: false,
			};
			const target = {
				...identity,
				number: resource.number,
				comments: false,
			};
			const live = async (): Promise<string> => {
				const diff = await fetchPrDiff(deps.gh, target, signal);
				return JSON.stringify(diff);
			};
			let outcome = await deps.cache.readThrough(cacheIdentity, live, signal);
			let diff: ReturnType<typeof parseCachedPrDiff>;
			try {
				diff = parseCachedPrDiff(outcome.text);
			} catch {
				// A malformed normalized row must not make the GitHub resource unusable.
				deps.cache.invalidate(cacheIdentity);
				outcome = await deps.cache.readThrough(cacheIdentity, live, signal);
				diff = parseCachedPrDiff(outcome.text);
			}
			const versionKey = [
				credentialFingerprint(deps.env) ?? "uncached",
				identity.host,
				identity.owner,
				identity.repo,
				resource.number,
			].join("\u0000");
			const version = createHash("sha256").update(outcome.text).digest("hex");
			const previousVersion = versionState?.get(versionKey);
			const changedDuringPagination =
				(request.offset !== undefined || request.limit !== undefined) &&
				previousVersion !== undefined &&
				previousVersion !== version;
			const rendered = renderPrDiff(diff, resource.number, resource.fileIndex);
			const page = paginateRendered(rendered, request.offset, request.limit);
			versionState?.set(versionKey, version);
			const notices: string[] = [];
			if (changedDuringPagination) notices.push(PR_DIFF_UPDATED_NOTICE);
			if (outcome.staleNotice) notices.push(outcome.staleNotice);
			return {
				...page,
				text:
					notices.length > 0
						? `${notices.join("\n")}\n\n${page.text}`
						: page.text,
			};
		}
		case "issue-list": {
			await deps.availability.ensureGh();
			const identity = await resolveResourceIdentity(deps, resource, signal);
			const issues = await fetchIssueList(
				deps.gh,
				{
					...identity,
					state: resource.state,
					limit: resource.limit,
					author: resource.author,
					label: resource.label,
				},
				signal,
			);
			return paginateRendered(
				renderIssueList(issues, identity),
				request.offset,
				request.limit,
			);
		}
		case "pr-list": {
			await deps.availability.ensureGh();
			const identity = await resolveResourceIdentity(deps, resource, signal);
			const pulls = await fetchPullRequestList(
				deps.gh,
				{
					...identity,
					state: resource.state,
					limit: resource.limit,
					author: resource.author,
					label: resource.label,
				},
				signal,
			);
			return paginateRendered(
				renderPullRequestList(pulls, identity),
				request.offset,
				request.limit,
			);
		}
	}
}

/**
 * Repository identity for a virtual resource. Explicit `owner/repo` is
 * honored; a host falls back to `GH_HOST` then github.com. A bare form
 * resolves the current checkout's GitHub repository locally (never a
 * network call) and throws the friendly repository-context error when
 * the checkout yields no GitHub remote (§49).
 */
async function resolveResourceIdentity(
	deps: GithubReadDeps,
	resource: GithubResource,
	signal?: AbortSignal,
): Promise<{ host: string; owner: string; repo: string }> {
	if (resource.owner && resource.repo) {
		return {
			host: resource.host ?? deps.env.GH_HOST ?? "github.com",
			owner: resource.owner,
			repo: resource.repo,
		};
	}
	const resolved = await resolveCurrentGithubRepo(
		{ git: deps.git, env: deps.env },
		signal,
	);
	return {
		host: resource.host ?? resolved.host,
		owner: resolved.owner,
		repo: resolved.repo,
	};
}

/**
 * The registered `read` tool body: replaces Pi's built-in read; native
 * reads pass through untouched.
 */
export function createGithubReadOverride(
	deps: GithubReadDeps,
): GithubReadOverride {
	const versionState = new Map<string, string>();
	return {
		async execute(toolCallId, params, signal, onUpdate) {
			if (!isGithubResourceUri(params.path)) {
				return deps.nativeRead.execute(toolCallId, params, signal, onUpdate);
			}
			const resource = parseGithubUri(params.path);
			const rendered = await readGithubResource(
				deps,
				resource,
				params,
				signal,
				versionState,
			);
			return {
				content: [{ type: "text", text: rendered.text }],
				details: { truncation: rendered.details.truncation },
			};
		},
	};
}

/** Build the cache facade from the read deps (single store, config-driven). */
export function createGithubCacheForDeps(deps: GithubReadDeps): GithubCache {
	return createGithubCache({
		getStore: () => openCacheStore(deps.getConfig().cacheDatabasePath),
		getSettings: () => deps.getConfig().github.cache,
		authKey: () => credentialFingerprint(deps.env),
	});
}
