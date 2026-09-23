/**
 * The `read` override — ticket 02 (docs/pi-omp-git-reference.md §7).
 *
 * `issue://` and `pr://` scheme URIs route to the GitHub resource
 * machinery; everything else delegates to Pi's native read with zero
 * behavior change. The result shape (content blocks + ReadToolDetails)
 * matches the native read, so pagination discipline carries over.
 * (Listing and PR renderings land with tickets 04/05/07 — the parser
 * already validates their grammar, so those forms fail with a clear
 * not-implemented-yet error here rather than a malformed-URI error.)
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ReadToolDetails } from "@earendil-works/pi-coding-agent";
import type { Availability } from "../availability.ts";
import type { GhRunner } from "../runner.ts";
import { fetchIssue } from "./issues.ts";
import { type GithubResource, parseGithubUri } from "./parser.ts";
import {
	paginateRendered,
	type RenderedResource,
	renderIssue,
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

export function isGithubResourceUri(path: string): boolean {
	return /^(issue|pr):\/\//i.test(path);
}

/** Route + fetch + render + paginate one virtual GitHub resource. */
export async function readGithubResource(
	deps: { gh: GhRunner; availability: Availability },
	resource: GithubResource,
	request: { offset?: number; limit?: number },
	signal?: AbortSignal,
): Promise<RenderedResource> {
	switch (resource.kind) {
		case "issue": {
			await deps.availability.ensureGh();
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
			return paginateRendered(
				renderIssue(issue, { comments: resource.comments }),
				request.offset,
				request.limit,
			);
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

/** Replaced by the real PR rendering in ticket 04; a placeholder error until then. */
export class PiOmpGitNotImplementedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiOmpGitNotImplementedError";
	}
}

/**
 * The registered `read` tool body: replaces Pi's built-in read; native
 * reads pass through untouched.
 */
export function createGithubReadOverride(deps: {
	gh: GhRunner;
	availability: Availability;
	nativeRead: NativeReadTool;
}): GithubReadOverride {
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
