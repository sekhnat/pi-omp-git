/**
 * `github {op: "pr_create"}` — create a pull request
 * (docs/pi-omp-git-reference.md §22).
 *
 * Either an explicit `title` or `fill: true` is required; the two are
 * mutually exclusive, as are `fill` and an explicit body. `fill` derives
 * title and body from the change through a nested headless agent session
 * (§75, src/github/nested-agent.ts). A nonempty body travels through a
 * temporary body file (`--body-file`); an explicitly empty body uses
 * `--body ""` — `gh` never opens an editor. After creation the returned
 * PR URL is parsed and a best-effort refresh renders a rich summary; a
 * refresh failure never turns a created PR into an error.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import type { GitRunner } from "../../git/runner.ts";
import {
	AuthenticationError,
	DependencyError,
	FRIENDLY_ERRORS,
	GithubApiError,
	PiOmpGitError,
} from "../../shared/errors.ts";
import {
	CommandNotFoundError,
	type RunResult,
} from "../../shared/subprocess.ts";
import {
	type NestedModel,
	type NestedSessionFactory,
	runNestedAgent,
} from "../nested-agent.ts";
import { parseGithubRepoIdentifier } from "../repo.ts";
import { fetchPullRequest, type PullTarget } from "../resources/prs.ts";
import { renderPullRequest } from "../resources/render.ts";
import type { GhRunner } from "../runner.ts";
import { GithubParamsError, optionalNonEmptyString } from "./params.ts";

export interface PrCreateTarget {
	/** `owner/repo` or `host/owner/repo`; omitted → gh resolves the checkout. */
	repo?: string;
	/** Explicit PR title (mutually exclusive with `fill`). */
	title?: string;
	/** Explicit body; empty string is valid and stays noninteractive. */
	body?: string;
	/** Target base branch; omitted → gh's inference. */
	base?: string;
	/** Head branch; omitted → the current branch (§22). */
	head?: string;
	/** Create the PR as a draft. */
	draft?: boolean;
	/** Generate title and body from the change via the nested agent. */
	fill?: boolean;
	reviewer?: string[];
	assignee?: string[];
	label?: string[];
}

export const PR_CREATE_OPERATION_PARAMETERS = Type.Object({
	op: Type.Literal("pr_create"),
	repo: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	body: Type.Optional(Type.String()),
	base: Type.Optional(Type.String()),
	head: Type.Optional(Type.String()),
	draft: Type.Optional(Type.Boolean()),
	fill: Type.Optional(Type.Boolean()),
	reviewer: Type.Optional(Type.Array(Type.String())),
	assignee: Type.Optional(Type.Array(Type.String())),
	label: Type.Optional(Type.Array(Type.String())),
});

export type PrCreateOperationArguments = Static<
	typeof PR_CREATE_OPERATION_PARAMETERS
>;

export function validatePrCreateOperationArguments(
	params: Record<string, unknown>,
): PrCreateOperationArguments {
	const body = params.body;
	if (body !== undefined && body !== null && typeof body !== "string") {
		throw new GithubParamsError(
			"The `body` parameter must be a string (empty is allowed).",
		);
	}
	const readBoolean = (field: "draft" | "fill"): boolean | undefined => {
		const value = params[field];
		if (value === undefined || value === null) return undefined;
		if (typeof value !== "boolean") {
			throw new GithubParamsError(
				`The \`${field}\` parameter must be a boolean.`,
			);
		}
		return value;
	};
	const readStringArray = (field: "reviewer" | "assignee" | "label") => {
		const value = params[field];
		if (value === undefined || value === null) return undefined;
		if (
			!Array.isArray(value) ||
			value.some((item) => typeof item !== "string" || item.trim() === "")
		) {
			throw new GithubParamsError(
				`The \`${field}\` parameter must be an array of non-empty strings.`,
			);
		}
		return value as string[];
	};
	const repo = optionalNonEmptyString(params, "repo");
	const title = optionalNonEmptyString(params, "title");
	const base = optionalNonEmptyString(params, "base");
	const head = optionalNonEmptyString(params, "head");
	const draft = readBoolean("draft");
	const fill = readBoolean("fill");
	const reviewer = readStringArray("reviewer");
	const assignee = readStringArray("assignee");
	const label = readStringArray("label");
	return {
		op: "pr_create",
		...(repo !== undefined ? { repo } : {}),
		...(title !== undefined ? { title } : {}),
		...(body !== undefined && body !== null ? { body } : {}),
		...(base !== undefined ? { base } : {}),
		...(head !== undefined ? { head } : {}),
		...(draft !== undefined ? { draft } : {}),
		...(fill !== undefined ? { fill } : {}),
		...(reviewer !== undefined ? { reviewer } : {}),
		...(assignee !== undefined ? { assignee } : {}),
		...(label !== undefined ? { label } : {}),
	};
}

export interface PrCreateDeps {
	gh: GhRunner;
	git: GitRunner;
	/** Working directory (also the nested agent's). */
	cwd: string;
	/** The parent session's model for fill (§75: model inheritance). */
	model?: NestedModel;
	/** Test seam for the nested session factory. */
	createNestedSession?: NestedSessionFactory;
	/** Body-file directory override (tests inject a stable path). */
	tempDir?: string;
}

export interface PrCreateResult {
	/** The canonical PR URL parsed from gh's output (§22). */
	url: string;
	/** The PR number, when the URL carried one. */
	number?: number;
	title: string;
	/** The rendered rich summary (post-create refresh or the basic form). */
	summary: string;
	/** True when the best-effort refresh failed (the PR still exists). */
	refreshFailed?: boolean;
}

/** The narrow read-only allowlist the fill agent may use. */
export const FILL_AGENT_TOOLS = ["read", "grep", "find", "ls"];

/** Validate §22 mutual-exclusion and required-input rules. */
export function validatePrCreateArguments(target: PrCreateTarget): void {
	if (target.fill) {
		if (target.title !== undefined) {
			throw new PiOmpGitError(
				"pr_create `fill` cannot be combined with an explicit `title`.",
			);
		}
		if (target.body !== undefined) {
			throw new PiOmpGitError(
				"pr_create `fill` cannot be combined with an explicit `body`.",
			);
		}
	} else if (typeof target.title !== "string" || target.title.trim() === "") {
		throw new PiOmpGitError(
			"pr_create requires an explicit `title` or `fill: true`.",
		);
	}
	for (const field of ["reviewer", "assignee", "label"] as const) {
		const values = target[field];
		if (!values) continue;
		if (
			!Array.isArray(values) ||
			values.some((value) => typeof value !== "string" || value.trim() === "")
		) {
			throw new PiOmpGitError(
				`The \`${field}\` parameter must be an array of non-empty strings.`,
			);
		}
	}
}

/** Resolve the `owner/repo` scope for an explicit repo (§19). */
function resolveExplicitRepo(target: PrCreateTarget): {
	scope: string;
	host?: string;
} {
	const identifier = parseGithubRepoIdentifier(target.repo ?? "");
	if (!identifier) {
		throw new PiOmpGitError(
			`Invalid repository identifier: ${target.repo}. Use owner/repo or host/owner/repo.`,
		);
	}
	return {
		scope: `${identifier.owner}/${identifier.repo}`,
		host: identifier.host,
	};
}

async function runGit(
	git: GitRunner,
	args: string[],
	signal: AbortSignal | undefined,
): Promise<RunResult> {
	try {
		return await git.run(args, { signal });
	} catch (error) {
		if (error instanceof CommandNotFoundError) {
			throw new DependencyError(FRIENDLY_ERRORS.gitMissing, "git");
		}
		throw error;
	}
}

/**
 * Best-effort fill context: head branch, the branch's commits, and the
 * diff stat against the base. Absolute facts (head branch) fail the fill;
 * context enrichment failures only degrade the prompt.
 */
async function gatherFillContext(
	deps: PrCreateDeps,
	target: PrCreateTarget,
	signal: AbortSignal | undefined,
): Promise<{ head: string; base?: string; context: string }> {
	const branch = await runGit(
		deps.git,
		["rev-parse", "--abbrev-ref", "HEAD"],
		signal,
	);
	if (branch.exitCode !== 0) {
		throw new PiOmpGitError(
			"pr_create `fill` could not determine the current branch from this checkout.",
		);
	}
	const head = branch.stdout.trim();

	// Base: explicit, else the checkout's upstream default (origin/HEAD).
	let base = target.base;
	if (!base) {
		const originHead = await runGit(
			deps.git,
			["symbolic-ref", "refs/remotes/origin/HEAD"],
			signal,
		);
		if (originHead.exitCode === 0) {
			base = originHead.stdout.trim().replace("refs/remotes/origin/", "");
		}
	}

	let context = "";
	if (base) {
		const mergeBase = await runGit(
			deps.git,
			["merge-base", "HEAD", base],
			signal,
		);
		if (mergeBase.exitCode === 0) {
			const point = mergeBase.stdout.trim();
			const [log, stat] = await Promise.all([
				runGit(
					deps.git,
					["log", "--format=%h %s%n%b%n---", `${point}..HEAD`],
					signal,
				),
				runGit(deps.git, ["diff", "--stat", `${point}..HEAD`], signal),
			]);
			if (log.exitCode === 0) {
				context += `Commits (newest first):\n${log.stdout.trim()}\n`;
			}
			if (stat.exitCode === 0 && stat.stdout.trim()) {
				context += `\nDiff stat:\n${stat.stdout.trim()}\n`;
			}
		}
	}
	if (!context) {
		// No base derivable: fall back to the branch's recent history.
		const log = await runGit(
			deps.git,
			["log", "--format=%h %s%n%b%n---", "--max-count=15", "HEAD"],
			signal,
		);
		if (log.exitCode === 0) {
			context += `Recent commits (newest first):\n${log.stdout.trim()}\n`;
		}
	}
	return { head, base, context };
}

function buildFillPrompt(context: {
	head: string;
	base?: string;
	context: string;
}): string {
	const lines = [
		"Generate a pull request title and body for the change on the current branch.",
		"",
		`Branch: ${context.head}`,
	];
	if (context.base) lines.push(`Target branch: ${context.base}`);
	lines.push("", context.context.trim());
	lines.push(
		"",
		"Respond with the title on the first line and the body on the following lines.",
		"The title is short, imperative, and specific; the body summarizes the change.",
		"Plain text only — no code fences, no headings, no alternatives.",
	);
	return lines.join("\n");
}

/** Split the nested agent's response: title first line, body the rest. */
export function parseFillResponse(text: string): {
	title: string;
	body: string;
} {
	const lines = text.split("\n").map((line) => line.trim());
	let title = "";
	let bodyIndex = lines.length;
	for (let index = 0; index < lines.length; index += 1) {
		const candidate = lines[index];
		if (candidate !== undefined && candidate !== "") {
			title = candidate;
			bodyIndex = index + 1;
			break;
		}
	}
	if (!title) {
		throw new PiOmpGitError(
			"The nested agent returned no usable pull request title for `fill`.",
		);
	}
	const body = lines
		.slice(bodyIndex)
		.join("\n")
		.replace(/^\s+/, "")
		.replace(/\s+$/, "");
	return { title, body };
}

/** Write the body to a temporary file for `--body-file` (§22). */
async function writeBodyFile(
	body: string,
	tempDir: string | undefined,
): Promise<{ path: string; cleanup(): Promise<void> }> {
	const dir = tempDir
		? tempDir
		: await mkdtemp(join(tmpdir(), "pi-omp-git-pr-create-"));
	const file = join(dir, "pr-body.md");
	await writeFile(file, body, "utf8");
	return {
		path: file,
		// An injected directory (tests) owns its own lifecycle; only our
		// own mkdtemp directory is removed wholesale.
		cleanup: tempDir
			? async () => {}
			: () => rm(dir, { recursive: true, force: true }),
	};
}

/** Classify a failed `gh pr create` into the stable taxonomy (§49). */
function classifyCreateFailure(result: RunResult): PiOmpGitError {
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
	const details = result.stderr
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	const bounded = details
		? details.length > 300
			? `${details.slice(0, 300)}…`
			: details
		: "";
	return new GithubApiError(
		bounded
			? `GitHub pull request creation failed: ${bounded}`
			: `GitHub pull request creation failed with exit code ${result.exitCode ?? "signal"}`,
	);
}

/**
 * Extract the canonical PR URL, number, and owner/repo identity from gh's
 * stdout (§22). The URL is the canonical post-create source of identity.
 */
export function parseCreatedPrUrl(stdout: string): {
	url: string;
	number?: number;
	host?: string;
	owner?: string;
	repo?: string;
} {
	const match = /https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(
		stdout,
	);
	if (!match) return { url: stdout.trim() };
	return {
		url: match[0],
		number: Number(match[4]),
		host: match[1],
		owner: match[2],
		repo: match[3],
	};
}

/** Create a pull request (§22). */
export async function createPullRequest(
	deps: PrCreateDeps,
	target: PrCreateTarget,
	signal?: AbortSignal,
): Promise<PrCreateResult> {
	validatePrCreateArguments(target);

	let title: string;
	let body: string | undefined;
	if (target.fill) {
		const context = await gatherFillContext(deps, target, signal);
		const run = await runNestedAgent({
			cwd: deps.cwd,
			prompt: buildFillPrompt(context),
			tools: FILL_AGENT_TOOLS,
			model: deps.model,
			signal,
			createSession: deps.createNestedSession,
		});
		const parsed = parseFillResponse(run.text);
		title = parsed.title;
		body = parsed.body;
	} else {
		title = (target.title ?? "").trim();
		body = target.body;
	}

	const argv: string[] = ["pr", "create"];
	let bodyCleanup: (() => Promise<void>) | undefined;
	if (body !== undefined && body !== "") {
		const file = await writeBodyFile(body, deps.tempDir);
		bodyCleanup = file.cleanup;
		argv.push("--title", title, "--body-file", file.path);
	} else {
		// Explicitly empty (or omitted) body: noninteractive, no editor (§22).
		argv.push("--title", title, "--body", "");
	}
	if (target.base) argv.push("--base", target.base);
	if (target.head) argv.push("--head", target.head);
	if (target.draft) argv.push("--draft");
	for (const reviewer of target.reviewer ?? [])
		argv.push("--reviewer", reviewer);
	for (const assignee of target.assignee ?? [])
		argv.push("--assignee", assignee);
	for (const label of target.label ?? []) argv.push("--label", label);

	let host: string | undefined;
	if (target.repo) {
		const explicit = resolveExplicitRepo(target);
		argv.push("-R", explicit.scope);
		host = explicit.host;
	}

	let result: RunResult;
	try {
		result = await deps.gh.run(argv, {
			signal,
			...(host ? { extraEnv: { GH_HOST: host } } : {}),
		});
	} catch (error) {
		if (error instanceof CommandNotFoundError) {
			throw new DependencyError(FRIENDLY_ERRORS.ghMissing, "gh");
		}
		throw error;
	} finally {
		await bodyCleanup?.();
	}
	if (result.exitCode !== 0) {
		throw classifyCreateFailure(result);
	}

	const {
		url,
		number,
		host: urlHost,
		owner,
		repo,
	} = parseCreatedPrUrl(result.stdout);

	// Best-effort refresh: a rich summary from the freshly created PR. A
	// refresh failure must NOT turn a created PR into an error (§22).
	let summary = `Created pull request: ${url}`;
	let refreshFailed: boolean | undefined;
	if (number !== undefined && owner && repo) {
		try {
			const pull = await fetchPullRequest(
				deps.gh,
				{
					host: urlHost ?? host,
					owner,
					repo,
					number,
					comments: false,
				} satisfies PullTarget,
				signal,
			);
			summary = renderPullRequest(pull, { comments: false });
		} catch {
			refreshFailed = true;
		}
	}
	return {
		url,
		number,
		title,
		summary,
		...(refreshFailed ? { refreshFailed: true } : {}),
	};
}
