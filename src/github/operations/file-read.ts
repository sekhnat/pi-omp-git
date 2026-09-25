/**
 * `github {op: "file_read"}` — read files stored in GitHub repositories
 * (docs/pi-omp-git-reference.md §21).
 *
 * Rules: `path` is mandatory and repository-relative (leading `/` rejected,
 * traversal segments rejected); path segments are individually URL-encoded
 * before the contents API request; branch omission means the default branch;
 * repo omission resolves the current GitHub checkout locally (§50). Text is
 * decoded directly, recognized images return image content blocks, other
 * binaries return metadata plus the GitHub source URL — binary content is
 * never decoded into mojibake. The contents API returns content only up to
 * 1 MiB; larger text files fall back to the raw media type, while larger
 * images and binaries degrade to metadata plus the source URL.
 */

import { type Static, Type } from "typebox";
import type { GitRunner } from "../../git/runner.ts";
import {
	AuthenticationError,
	DependencyError,
	FRIENDLY_ERRORS,
	GithubApiError,
	InvalidJsonError,
	PiOmpGitError,
	ResourceNotFoundError,
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
import { optionalNonEmptyString } from "./params.ts";

export interface FileReadTarget {
	/** `owner/repo` or `host/owner/repo`; omitted → current checkout. */
	repo?: string;
	/** Branch, tag, or commit ref; omitted → repository default branch. */
	branch?: string;
	/** Repository-relative path (no leading slash, no traversal segments). */
	path: string;
}

export const FILE_READ_OPERATION_PARAMETERS = Type.Object({
	op: Type.Literal("file_read"),
	repo: Type.Optional(Type.String()),
	branch: Type.Optional(Type.String()),
	path: Type.Optional(Type.String()),
});

export type FileReadOperationArguments = Static<
	typeof FILE_READ_OPERATION_PARAMETERS
>;

export function validateFileReadOperationArguments(
	params: Record<string, unknown>,
): FileReadOperationArguments {
	const repo = optionalNonEmptyString(params, "repo");
	const branch = optionalNonEmptyString(params, "branch");
	const path = optionalNonEmptyString(params, "path");
	return {
		op: "file_read",
		...(repo !== undefined ? { repo } : {}),
		...(branch !== undefined ? { branch } : {}),
		...(path !== undefined ? { path } : {}),
	};
}

/** The classification of one fetched file. */
export type FileReadKind = "text" | "image" | "binary";

export interface FileReadResult {
	kind: FileReadKind;
	/** Decoded text (kind "text"). */
	text?: string;
	/** Base64 payload and MIME type (kind "image"). */
	image?: { data: string; mimeType: string };
	/** Size in bytes when known. */
	size?: number;
	/** Human-facing metadata rendered for binary content. */
	metadata?: string;
	/** The GitHub web URL for the file at the requested ref. */
	sourceUrl?: string;
	/** The runner's 8 MiB cap cut the content. */
	truncated?: boolean;
	/** The path resolved as a submodule rather than an ordinary file. */
	entryType?: string;
}

/** MIME types the model-facing image content block supports reliably. */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/** GitHub's contents API stops returning `content` beyond this size. */
const CONTENTS_API_MAX_BYTES = 1024 * 1024;

/** Binary sniffing window. */
const SNIFF_WINDOW = 8192;

interface ContentsApiResponse {
	type?: string;
	name?: string;
	path?: string;
	size?: number;
	content?: string | null;
	encoding?: string | null;
	html_url?: string | null;
}

export interface FileReadDeps {
	gh: GhRunner;
	git: GitRunner;
	env: NodeJS.ProcessEnv;
}

/**
 * Validate a repository-relative path. Returns the trimmed path (the caller
 * URL-encodes the segments). Rejects: empty, leading `/`, "." / ".."
 * segments, empty segments (covers "//" and trailing "/"), and control
 * characters.
 */
export function validateFileReadPath(path: string): string {
	if (typeof path !== "string" || path.trim() === "") {
		throw new PiOmpGitError(
			'file_read requires a repository-relative `path` (for example "src/index.ts").',
		);
	}
	const trimmed = path.trim();
	if (trimmed.startsWith("/") || trimmed.startsWith("\\")) {
		throw new PiOmpGitError(
			`file_read paths must be repository-relative — "${trimmed}" starts at the filesystem root.`,
		);
	}
	for (const segment of trimmed.split("/")) {
		if (segment === "") {
			throw new PiOmpGitError(
				`file_read paths cannot contain empty segments — "${trimmed}" is malformed.`,
			);
		}
		if (segment === "." || segment === "..") {
			throw new PiOmpGitError(
				`file_read paths cannot contain traversal segments — "${segment}" in "${trimmed}" is rejected.`,
			);
		}
	}
	const hasControlCharacter = [...trimmed].some((character) => {
		const code = character.charCodeAt(0);
		return code < 0x20 || code === 0x7f;
	});
	if (hasControlCharacter) {
		throw new PiOmpGitError(
			"file_read paths cannot contain control characters.",
		);
	}
	return trimmed;
}

/** Individually URL-encode each path segment (§21). */
export function encodeContentsPath(path: string): string {
	return path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

/** MIME type for a recognized image extension, else undefined. */
export function imageMimeType(path: string): string | undefined {
	const extension = path.split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_MIME_BY_EXTENSION[extension];
}

/**
 * The GitHub web URL for the file at the requested ref. Used when the API
 * response does not carry `html_url` (the raw-media fallback path).
 */
export function buildSourceUrl(
	host: string,
	owner: string,
	repo: string,
	branch: string | undefined,
	path: string,
): string {
	const ref = branch ?? "HEAD";
	const encoded = encodeContentsPath(path);
	return `https://${host}/${owner}/${repo}/blob/${ref}/${encoded}`;
}

/** True when the text prefix carries a NUL byte — a binary marker. */
export function looksBinary(text: string): boolean {
	return text.slice(0, SNIFF_WINDOW).includes("\u0000");
}

export function sanitizeStderr(result: RunResult): string {
	const line = result.stderr
		.split("\n")
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate.length > 0);
	if (!line) return "";
	return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

interface ContentsTarget {
	host: string;
	owner: string;
	repo: string;
	branch?: string;
	path: string;
}

/** `gh api repos/{owner}/{repo}/contents/{path}[?ref={branch}] [-H ...]`. */
export function contentsApiArgs(
	target: ContentsTarget,
	headers: string[] = [],
): string[] {
	const encoded = encodeContentsPath(target.path);
	let requestPath = `repos/${target.owner}/${target.repo}/contents/${encoded}`;
	if (target.branch) {
		requestPath += `?ref=${encodeURIComponent(target.branch)}`;
	}
	return ["api", requestPath, ...headers];
}

/** Classify a failed contents-API call into the stable taxonomy (§49). */
function classifyApiFailure(
	target: ContentsTarget,
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
	if (/not found|http 404/i.test(stderr)) {
		const ref = target.branch ? ` on branch ${target.branch}` : "";
		return new ResourceNotFoundError(
			`GitHub file ${target.path} was not found in ${target.owner}/${target.repo}${ref}.`,
		);
	}
	const details = sanitizeStderr(result);
	return new GithubApiError(
		details
			? `GitHub contents request failed for ${target.path}: ${details}`
			: `GitHub contents request failed for ${target.path} with exit code ${result.exitCode ?? "signal"}`,
	);
}

/**
 * Build the result for content we choose not to inline (other binaries, and
 * images/blobs too large for the contents API): metadata plus the GitHub
 * source URL (§21).
 */
function metadataResult(
	target: ContentsTarget,
	options: {
		size?: number;
		entryType?: string;
		sourceUrl?: string;
		note?: string;
	},
): FileReadResult {
	const sourceUrl =
		options.sourceUrl ??
		buildSourceUrl(
			target.host,
			target.owner,
			target.repo,
			target.branch,
			target.path,
		);
	const lines = [
		`Binary file: ${target.path}`,
		`Repository: ${target.owner}/${target.repo}`,
		`Ref: ${target.branch ?? "HEAD"}`,
	];
	if (options.size !== undefined) lines.push(`Size: ${options.size} bytes`);
	if (options.entryType) lines.push(`Entry type: ${options.entryType}`);
	if (options.note) lines.push(options.note);
	lines.push(`Source: ${sourceUrl}`);
	return {
		kind: "binary",
		size: options.size,
		entryType: options.entryType,
		metadata: `${lines.join("\n")}\n`,
		sourceUrl,
	};
}

/** Fetch through the contents API, honoring the ref and host. */
async function fetchContents(
	deps: FileReadDeps,
	target: ContentsTarget,
	headers: string[],
	signal?: AbortSignal,
): Promise<RunResult> {
	try {
		return await deps.gh.run(contentsApiArgs(target, headers), {
			signal,
			extraEnv: { GH_HOST: target.host },
		});
	} catch (error) {
		if (error instanceof CommandNotFoundError) {
			throw new DependencyError(FRIENDLY_ERRORS.ghMissing, "gh");
		}
		throw error;
	}
}

/** The GitHub "content too large" (too_large) marker from the API. */
function isTooLarge(result: RunResult): boolean {
	return /too_large|too large/i.test(result.stderr);
}

/**
 * The too-large fallback: stream raw bytes through the raw media type.
 * Images and other binaries degrade to metadata (the runner's string
 * transport is text-safe only); text comes back decoded with an honest
 * truncation notice when the 8 MiB cap cut it.
 */
async function fetchTooLargeFallback(
	deps: FileReadDeps,
	target: ContentsTarget,
	signal?: AbortSignal,
): Promise<FileReadResult> {
	const result = await fetchContents(
		deps,
		target,
		["-H", "Accept: application/vnd.github.raw"],
		signal,
	);
	if (result.exitCode !== 0) {
		throw classifyApiFailure(target, result);
	}
	const size = Buffer.byteLength(result.stdout, "utf8");
	const truncated = result.truncated || undefined;
	const limitKiB = Math.round(CONTENTS_API_MAX_BYTES / 1024);
	if (imageMimeType(target.path)) {
		return {
			...metadataResult(target, {
				size,
				note: `This ${imageMimeType(target.path)} file is larger than the ${limitKiB} KiB contents API limit, so it is not inlined as image content.`,
			}),
			truncated,
		};
	}
	if (looksBinary(result.stdout)) {
		return metadataResult(target, {
			size,
			note: `This file is larger than the ${limitKiB} KiB contents API limit, so its content is not inlined.`,
		});
	}
	return { kind: "text", text: result.stdout, size, truncated };
}

/**
 * Fetch one file from a GitHub repository. Text decodes directly; recognized
 * images become image content blocks; other binaries return metadata plus
 * the GitHub source URL.
 */
export async function fetchFileRead(
	deps: FileReadDeps,
	target: FileReadTarget,
	signal?: AbortSignal,
): Promise<FileReadResult> {
	const path = validateFileReadPath(target.path);

	// Resolve the repository identity. An explicit repo is honored (host
	// falls back to GH_HOST then github.com); an omitted repo resolves the
	// current checkout locally — never a network call (§21, §50).
	let host: string;
	let owner: string;
	let repo: string;
	if (target.repo) {
		const identifier = parseGithubRepoIdentifier(target.repo);
		if (!identifier) {
			throw new PiOmpGitError(
				`Invalid repository identifier: ${target.repo}. Use owner/repo or host/owner/repo.`,
			);
		}
		host = identifier.host ?? deps.env.GH_HOST ?? "github.com";
		owner = identifier.owner;
		repo = identifier.repo;
	} else {
		const resolved = await resolveCurrentGithubRepo(
			{ git: deps.git, env: deps.env },
			signal,
		);
		host = resolved.host;
		owner = resolved.owner;
		repo = resolved.repo;
	}
	const contentsTarget: ContentsTarget = {
		host,
		owner,
		repo,
		branch: target.branch,
		path,
	};

	const primary = await fetchContents(deps, contentsTarget, [], signal);
	if (primary.exitCode !== 0) {
		if (isTooLarge(primary)) {
			return fetchTooLargeFallback(deps, contentsTarget, signal);
		}
		throw classifyApiFailure(contentsTarget, primary);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(primary.stdout);
	} catch {
		throw new InvalidJsonError();
	}
	if (Array.isArray(parsed)) {
		throw new PiOmpGitError(
			`GitHub path ${path} in ${owner}/${repo} is a directory, not a file.`,
		);
	}
	const entry = parsed as ContentsApiResponse;
	if (!entry || typeof entry !== "object" || !entry.type) {
		throw new InvalidJsonError();
	}

	// Submodules are not readable files; symlinks surface their target text.
	if (entry.type === "submodule") {
		return metadataResult(contentsTarget, {
			size: entry.size,
			entryType: "submodule",
			note: "This path is a git submodule; its contents live in the linked repository.",
			sourceUrl: entry.html_url ?? undefined,
		});
	}

	if (typeof entry.content !== "string") {
		// No content on the row: retry through the raw media type.
		return fetchTooLargeFallback(deps, contentsTarget, signal);
	}

	if (imageMimeType(path)) {
		const mime = imageMimeType(path) as string;
		return {
			kind: "image",
			image: { data: entry.content.replace(/\s+/g, ""), mimeType: mime },
			size: entry.size,
			sourceUrl: entry.html_url ?? undefined,
		};
	}

	// The contents API always returns base64; decode to raw bytes so binary
	// content is classified — never decoded into mojibake (§21).
	const bytes = Buffer.from(entry.content, "base64");
	if (bytes.subarray(0, SNIFF_WINDOW).includes(0)) {
		return metadataResult(contentsTarget, {
			size: entry.size,
			sourceUrl: entry.html_url ?? undefined,
		});
	}
	return {
		kind: "text",
		text: bytes.toString("utf8"),
		size: entry.size,
		sourceUrl: entry.html_url ?? undefined,
	};
}
