/**
 * The `read` override — tickets 02 + 03 (docs/pi-omp-git-reference.md §7).
 *
 * `issue://` and `pr://` scheme URIs route to the GitHub resource
 * machinery; everything else delegates to Pi's native read with zero
 * behavior change. The result shape (content blocks + ReadToolDetails)
 * matches the native read, so pagination discipline carries over.
 * (Listing and PR renderings land with tickets 04/05/07 — the parser
 * already validates their grammar, so those forms fail with a clear
 * not-implemented-yet error here rather than a malformed-URI error.)
 *
 * Since ticket 03, single-issue reads flow through the cache facade:
 * fresh rows are served without a second `gh` invocation, the soft/hard
 * TTL bands apply, and bare-form reads resolve the current repository
 * locally (never a network call) so cache rows can be scoped by repo.
 * The live `gh` call itself stays bare for bare-form reads — `gh`
 * performs its own repository resolution from the checkout (§ repo
 * resolution); the resolved identity only feeds the cache key.
 */

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
import { fetchIssue } from "./issues.ts";
import { type GithubResource, parseGithubUri } from "./parser.ts";
import { paginateRendered, renderIssue } from "./render.ts";

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

export class PiOmpGitNotImplementedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiOmpGitNotImplementedError";
	}
}

/** Route + fetch + render + paginate one virtual GitHub resource. */
export async function readGithubResource(
	deps: GithubReadDeps,
	resource: GithubResource,
	request: { offset?: number; limit?: number },
	signal?: AbortSignal,
): Promise<RenderedResource> {
	switch (resource.kind) {
		case "issue": {
			await deps.availability.ensureGh();
			const identity = await resolveIssueIdentity(deps, resource, signal);
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
		case "pr":
			throw new PiOmpGitNotImplementedError(
				"PR resources (pr://N) are not implemented yet.",
			);
		case "pr-diff":
			throw new PiOmpGitNotImplementedError(
				"PR diff resources (pr://N/diff) are not implemented yet.",
			);
		case "issue-list":
			throw new PiOmpGitNotImplementedError(
				"Issue listing (issue://) is not implemented yet.",
			);
		case "pr-list":
			throw new PiOmpGitNotImplementedError(
				"PR listing (pr://) is not implemented yet.",
			);
	}
}

/**
 * Repository identity for a virtual resource. Explicit `owner/repo` is
 * honored; a host falls back to `GH_HOST` then github.com. A bare form
 * resolves the current checkout's GitHub repository locally (never a
 * network call) and throws the friendly repository-context error when
 * the checkout yields no GitHub remote (§49).
 */
async function resolveIssueIdentity(
	deps: GithubReadDeps,
	resource: GithubResource & { kind: "issue" },
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
	return {
		async execute(toolCallId, params, signal, onUpdate) {
			if (!isGithubResourceUri(params.path)) {
				return deps.nativeRead.execute(toolCallId, params, signal, onUpdate);
			}
			const resource = parseGithubUri(params.path);
			const rendered = await readGithubResource(deps, resource, params, signal);
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
