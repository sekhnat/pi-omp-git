/**
 * The `github` dispatcher tool — one model-callable operation surface for
 * the GitHub subsystem (docs/pi-omp-git-reference.md §18). The operation
 * enum is the stable dispatcher contract; `repo_view` and `file_read`
 * arrive with ticket 08, and later tickets fill in the remaining
 * operations with clear errors until they land.
 *
 * Errors are thrown from `execute()` so Pi produces a failed tool result
 * from the message alone — no stack traces, no echoed tokens (§49).
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { GitRunner } from "../git/runner.ts";
import { PiOmpGitError } from "../shared/errors.ts";
import type { Availability } from "./availability.ts";
import { fetchFileRead } from "./operations/file-read.ts";
import { fetchRepoView, renderRepoView } from "./operations/repo-view.ts";
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
});

export type GithubToolArguments = Static<typeof GithubToolParams>;

export interface GithubToolDetails {
	op?: string;
	repo?: string;
	branch?: string;
	path?: string;
	kind?: string;
	truncated?: boolean;
}

export interface GithubToolDeps {
	gh: GhRunner;
	git: GitRunner;
	availability: Availability;
	env: NodeJS.ProcessEnv;
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
	): Promise<AgentToolResult<GithubToolDetails>>;
}

const TOOL_DESCRIPTION = `GitHub operations through one dispatcher. Uses the authenticated GitHub CLI; no separate token setup.

Operations:
- repo_view: repository metadata (description, URL, default branch, visibility, permission, language, stars, forks, archived/fork status, topics).
- file_read: a file from a GitHub repository — text decoded, images returned as image content, other binaries as metadata with the GitHub source URL.
(Upcoming operations: pr_create, pr_checkout, pr_push, search_issues, search_prs, search_code, search_commits, search_repos, run_watch.)

Use repo_view to orient in an unfamiliar repository and file_read instead of curl/wget for files stored in GitHub repositories.`;

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
	const validated: GithubToolArguments = { op: op as GithubOperation };
	for (const field of ["repo", "branch", "path"] as const) {
		const value = record[field];
		if (value === undefined || value === null) continue;
		if (typeof value !== "string" || value.trim() === "") {
			throw new GithubParamsError(
				`The \`${field}\` parameter must be a non-empty string.`,
			);
		}
		validated[field] = value;
	}
	return validated;
}

/** Execute one repo_view or file_read operation. */
export async function executeGithubOperation(
	deps: GithubToolDeps,
	params: GithubToolArguments,
	signal?: AbortSignal,
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
	}
	throw new GithubParamsError(
		`github operation "${params.op}" is not available in this build of pi-omp-git yet.`,
	);
}

/** Build the `github` dispatcher tool for registration with Pi. */
export function createGithubTool(deps: GithubToolDeps): GithubTool {
	return {
		name: "github",
		label: "github",
		description: TOOL_DESCRIPTION,
		parameters: GithubToolParams,
		async execute(_toolCallId, params, signal) {
			const validated = validateGithubArguments(params);
			return executeGithubOperation(deps, validated, signal);
		},
	};
}
