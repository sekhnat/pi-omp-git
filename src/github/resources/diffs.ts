/**
 * Primary and fallback `pr://N/diff` fetch, normalized cache shape, and views
 * (docs/pi-omp-git-reference.md §§15–§17; tickets 05–06).
 *
 * The primary unified diff is retained verbatim; fallback sections are
 * synthesized deterministically from API file patches. Boundaries and slices
 * use JavaScript string indices (UTF-16 code units).
 */

import {
	DependencyError,
	FRIENDLY_ERRORS,
	InvalidJsonError,
	PiOmpGitError,
} from "../../shared/errors.ts";
import {
	CommandNotFoundError,
	type RunResult,
} from "../../shared/subprocess.ts";
import type { GhRunner } from "../runner.ts";
import { classifyPullFailure, type PullTarget, runOptions } from "./prs.ts";

export interface DiffFileIndex {
	index: number;
	path: string;
	oldPath?: string;
	changeType: "modified" | "added" | "deleted" | "renamed";
	additions?: number;
	deletions?: number;
	binary: boolean;
	patchUnavailable?: boolean;
	/** UTF-16 code-unit offset into `CachedPrDiff.unifiedDiff`. */
	startIndex: number;
	/** Exclusive UTF-16 code-unit offset into `CachedPrDiff.unifiedDiff`. */
	endIndex: number;
}

export interface CachedPrDiff {
	unifiedDiff: string;
	files: DiffFileIndex[];
}

const FILES_PER_PAGE = 100;
const MAX_CHANGED_FILES = 3_000;
const PATCH_UNAVAILABLE_MARKER = "Patch unavailable from GitHub for this file.";

interface PullRequestDiffFile {
	filename: string;
	previousFilename?: string;
	status: string;
	additions: number;
	deletions: number;
	patch?: string;
}

export const PR_DIFF_UPDATED_NOTICE =
	"GitHub PR diff updated since the previous read; pagination may need to restart.";

export function prDiffArgs(target: PullTarget): string[] {
	return [
		"pr",
		"diff",
		String(target.number),
		"--color",
		"never",
		"--repo",
		`${target.owner}/${target.repo}`,
	];
}

/** Fetch the aggregate diff, falling back to paginated per-file patches on HTTP 406. */
export async function fetchPrDiff(
	gh: GhRunner,
	target: PullTarget,
	signal?: AbortSignal,
): Promise<CachedPrDiff> {
	const result = await runGh(gh, target, prDiffArgs(target), signal);
	if (result.truncated) {
		throw new PiOmpGitError(
			"GitHub pull request diff output exceeded the process output limit and was truncated.",
		);
	}
	if (result.exitCode !== 0) {
		if (isAggregateDiffRejection(result)) {
			return fetchFallbackPrDiff(gh, target, signal);
		}
		throw classifyPullFailure(target, result);
	}
	return parseUnifiedDiff(result.stdout);
}

async function runGh(
	gh: GhRunner,
	target: PullTarget,
	args: string[],
	signal?: AbortSignal,
): Promise<RunResult> {
	try {
		return await gh.run(args, { signal, ...runOptions(target) });
	} catch (error) {
		if (error instanceof CommandNotFoundError) {
			throw new DependencyError(FRIENDLY_ERRORS.ghMissing, "gh");
		}
		throw error;
	}
}

function isAggregateDiffRejection(result: RunResult): boolean {
	return /\b(?:HTTP\s+)?406\b/i.test(result.stderr);
}

function requireSuccessfulGhResult(
	target: PullTarget,
	result: RunResult,
	truncatedMessage: string,
): void {
	if (result.truncated) throw new PiOmpGitError(truncatedMessage);
	if (result.exitCode !== 0) throw classifyPullFailure(target, result);
}

function perFileArgs(target: PullTarget, page: number): string[] {
	return [
		"api",
		`repos/${target.owner}/${target.repo}/pulls/${target.number}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
	];
}

function changedFileCountArgs(target: PullTarget): string[] {
	return [
		"api",
		`repos/${target.owner}/${target.repo}/pulls/${target.number}`,
		"--jq",
		".changed_files",
	];
}

async function fetchFallbackPrDiff(
	gh: GhRunner,
	target: PullTarget,
	signal?: AbortSignal,
): Promise<CachedPrDiff> {
	// Check the uncapped total so the 3,000-row list cap can't look complete.
	const changedFileCount = await fetchChangedFileCount(gh, target, signal);
	if (changedFileCount > MAX_CHANGED_FILES) throw changedFileLimitError(target);
	const files: PullRequestDiffFile[] = [];
	for (let page = 1; files.length < changedFileCount; page++) {
		const result = await runGh(gh, target, perFileArgs(target, page), signal);
		requireSuccessfulGhResult(
			target,
			result,
			`PR #${target.number} changed-file fallback response for page ${page} exceeded the process output limit.`,
		);
		const pageFiles = parsePerFilePage(result.stdout);
		if (pageFiles.length === 0) break;
		files.push(...pageFiles);
	}
	if (files.length !== changedFileCount) {
		throw new PiOmpGitError(
			`PR #${target.number} reports ${changedFileCount} changed files, but GitHub's per-file API returned ${files.length}; refusing an incomplete fallback.`,
		);
	}
	files.sort(compareDiffFiles);
	return synthesizeFallbackDiff(files);
}

async function fetchChangedFileCount(
	gh: GhRunner,
	target: PullTarget,
	signal?: AbortSignal,
): Promise<number> {
	const result = await runGh(gh, target, changedFileCountArgs(target), signal);
	requireSuccessfulGhResult(
		target,
		result,
		`PR #${target.number} changed-file count response exceeded the process output limit.`,
	);
	const countText = result.stdout.trim();
	const count = Number(countText);
	if (!/^\d+$/.test(countText) || !Number.isSafeInteger(count)) {
		throw new InvalidJsonError();
	}
	return count;
}

function changedFileLimitError(target: PullTarget): PiOmpGitError {
	return new PiOmpGitError(
		`PR #${target.number} exceeds GitHub's 3,000-file per-file API limit; the fallback cannot return a complete diff.`,
	);
}

function parsePerFilePage(stdout: string): PullRequestDiffFile[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new InvalidJsonError();
	}
	if (!Array.isArray(parsed)) throw new InvalidJsonError();
	return parsed.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new InvalidJsonError();
		}
		const file = value as Record<string, unknown>;
		if (
			typeof file.filename !== "string" ||
			typeof file.status !== "string" ||
			typeof file.additions !== "number" ||
			!Number.isInteger(file.additions) ||
			file.additions < 0 ||
			typeof file.deletions !== "number" ||
			!Number.isInteger(file.deletions) ||
			file.deletions < 0
		) {
			throw new InvalidJsonError();
		}
		return {
			filename: file.filename,
			previousFilename:
				typeof file.previous_filename === "string"
					? file.previous_filename
					: undefined,
			status: file.status,
			additions: file.additions,
			deletions: file.deletions,
			patch:
				typeof file.patch === "string" && file.patch.length > 0
					? file.patch
					: undefined,
		};
	});
}

function compareDiffFiles(
	left: PullRequestDiffFile,
	right: PullRequestDiffFile,
): number {
	if (left.filename < right.filename) return -1;
	if (left.filename > right.filename) return 1;
	const leftOld = left.previousFilename ?? "";
	const rightOld = right.previousFilename ?? "";
	if (leftOld < rightOld) return -1;
	if (leftOld > rightOld) return 1;
	return left.status < right.status ? -1 : left.status > right.status ? 1 : 0;
}

function synthesizeFallbackDiff(files: PullRequestDiffFile[]): CachedPrDiff {
	const unifiedDiff = files.map(synthesizeFilePatch).join("");
	const parsed = parseUnifiedDiff(unifiedDiff);
	return {
		unifiedDiff,
		files: parsed.files.map((file, index) => ({
			...file,
			additions: files[index]?.additions ?? file.additions,
			deletions: files[index]?.deletions ?? file.deletions,
		})),
	};
}

function synthesizeFilePatch(file: PullRequestDiffFile): string {
	const status =
		file.status === "added" ||
		file.status === "removed" ||
		file.status === "renamed"
			? file.status
			: "modified";
	const oldPath = file.previousFilename ?? file.filename;
	const lines = [
		`diff --git ${quoteGitPath(`a/${oldPath}`)} ${quoteGitPath(`b/${file.filename}`)}`,
	];
	if (status === "added") lines.push("new file mode 100644");
	if (status === "removed") lines.push("deleted file mode 100644");
	if (status === "renamed") {
		lines.push(`rename from ${quoteGitPath(oldPath)}`);
		lines.push(`rename to ${quoteGitPath(file.filename)}`);
	}
	lines.push(
		status === "added"
			? "--- /dev/null"
			: `--- ${quoteGitPath(`a/${oldPath}`)}`,
		status === "removed"
			? "+++ /dev/null"
			: `+++ ${quoteGitPath(`b/${file.filename}`)}`,
	);
	if (file.patch)
		lines.push(...file.patch.replaceAll("\r\n", "\n").split("\n"));
	else lines.push(PATCH_UNAVAILABLE_MARKER);
	return `${lines.join("\n")}\n`;
}

function quoteGitPath(path: string): string {
	let quoted = '"';
	for (const byte of Buffer.from(path, "utf8")) {
		if (byte === 0x22) quoted += '\\"';
		else if (byte === 0x5c) quoted += "\\\\";
		else if (byte === 0x09) quoted += "\\t";
		else if (byte === 0x0a) quoted += "\\n";
		else if (byte === 0x0d) quoted += "\\r";
		else if (byte >= 0x20 && byte < 0x7f) quoted += String.fromCharCode(byte);
		else quoted += `\\${byte.toString(8).padStart(3, "0")}`;
	}
	return `${quoted}"`;
}

/** Parse file sections in source order, retaining exact section offsets. */
export function parseUnifiedDiff(unifiedDiff: string): CachedPrDiff {
	const boundaries = [...unifiedDiff.matchAll(/^diff --git /gm)].map(
		(match) => match.index ?? 0,
	);
	if (boundaries.length === 0 && unifiedDiff.length > 0) {
		throw new PiOmpGitError(
			"GitHub returned a malformed pull request diff (missing diff --git file boundaries).",
		);
	}
	const files = boundaries.map((startIndex, position): DiffFileIndex => {
		const endIndex = boundaries[position + 1] ?? unifiedDiff.length;
		const section = unifiedDiff.slice(startIndex, endIndex);
		return parseDiffFile(section, position + 1, startIndex, endIndex);
	});
	return { unifiedDiff, files };
}

function parseDiffFile(
	section: string,
	index: number,
	startIndex: number,
	endIndex: number,
): DiffFileIndex {
	const lines = section.split(/\r?\n/);
	const renameFrom = lineValue(lines, "rename from ");
	const renameTo = lineValue(lines, "rename to ");
	const oldMarker = lines.find((line) => line.startsWith("--- "));
	const newMarker = lines.find((line) => line.startsWith("+++ "));
	const headerPaths = parseGitHeaderPaths(lines[0] ?? "");
	const markerOldPath = oldMarker
		? parseMarkerPath(oldMarker.slice(4))
		: undefined;
	const markerNewPath = newMarker
		? parseMarkerPath(newMarker.slice(4))
		: undefined;
	const oldPath = renameFrom ?? markerOldPath ?? headerPaths.oldPath;
	const newPath = renameTo ?? markerNewPath ?? headerPaths.newPath;
	const path = newPath ?? oldPath ?? headerPaths.newPath ?? headerPaths.oldPath;
	if (!path) {
		throw new PiOmpGitError(
			`GitHub returned a malformed pull request diff at file ${index} (missing path).`,
		);
	}

	const binary = lines.some(
		(line) => line.startsWith("Binary files ") || line === "GIT binary patch",
	);
	const isRename = renameFrom !== undefined || renameTo !== undefined;
	const isAdded =
		lines.some((line) => line.startsWith("new file mode ")) ||
		(oldMarker !== undefined && markerOldPath === undefined);
	const isDeleted =
		lines.some((line) => line.startsWith("deleted file mode ")) ||
		(newMarker !== undefined && markerNewPath === undefined);
	const changeType: DiffFileIndex["changeType"] = isRename
		? "renamed"
		: isAdded
			? "added"
			: isDeleted
				? "deleted"
				: "modified";

	let additions = 0;
	let deletions = 0;
	let inHunk = false;
	for (const line of lines) {
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		if (line.startsWith("+")) additions++;
		else if (line.startsWith("-")) deletions++;
	}

	return {
		index,
		path,
		oldPath: isRename && oldPath !== path ? oldPath : undefined,
		changeType,
		additions,
		deletions,
		binary,
		patchUnavailable: lines.includes(PATCH_UNAVAILABLE_MARKER),
		startIndex,
		endIndex,
	};
}

function lineValue(lines: string[], prefix: string): string | undefined {
	const line = lines.find((candidate) => candidate.startsWith(prefix));
	return line ? parseMarkerPath(line.slice(prefix.length)) : undefined;
}

function parseMarkerPath(raw: string): string | undefined {
	const pathToken = raw.split("\t", 1)[0] ?? raw;
	const path = decodeGitPath(pathToken);
	if (!path || path === "/dev/null") return undefined;
	return path.replace(/^[ab]\//, "");
}

/** Decode Git's quoted path form, including octal-escaped UTF-8 bytes. */
function decodeGitPath(raw: string): string {
	if (!raw.startsWith('"')) return raw;
	let result = "";
	const octalBytes: number[] = [];
	const flushOctalBytes = (): void => {
		if (octalBytes.length === 0) return;
		result += Buffer.from(octalBytes).toString("utf8");
		octalBytes.length = 0;
	};
	for (let index = 1; index < raw.length; index++) {
		const character = raw[index] ?? "";
		if (character === '"') {
			flushOctalBytes();
			return result;
		}
		if (character !== "\\") {
			flushOctalBytes();
			result += character;
			continue;
		}
		index++;
		const escaped = raw[index] ?? "";
		const commonEscapes: Record<string, string> = {
			'"': '"',
			"\\": "\\",
			t: "\t",
			n: "\n",
			r: "\r",
			b: "\b",
			f: "\f",
			v: "\v",
		};
		if (commonEscapes[escaped] !== undefined) {
			flushOctalBytes();
			result += commonEscapes[escaped];
			continue;
		}
		if (/[0-7]/.test(escaped)) {
			let octal = escaped;
			for (
				let digits = 0;
				digits < 2 && /[0-7]/.test(raw[index + 1] ?? "");
				digits++
			) {
				index++;
				octal += raw[index];
			}
			octalBytes.push(Number.parseInt(octal, 8));
		} else {
			flushOctalBytes();
			result += escaped;
		}
	}
	return raw;
}

function parseGitHeaderPaths(header: string): {
	oldPath?: string;
	newPath?: string;
} {
	const content = header.startsWith("diff --git ")
		? header.slice("diff --git ".length)
		: "";
	if (!content) return {};
	if (content.startsWith('"')) {
		const oldToken = quotedToken(content);
		if (!oldToken) return {};
		const remainder = content.slice(oldToken.length).trimStart();
		const newToken = remainder.startsWith('"')
			? quotedToken(remainder)
			: remainder;
		return {
			oldPath: parseMarkerPath(oldToken),
			newPath: newToken ? parseMarkerPath(newToken) : undefined,
		};
	}
	let candidate: { oldPath?: string; newPath?: string } | undefined;
	for (
		let separator = content.indexOf(" b/");
		separator >= 0;
		separator = content.indexOf(" b/", separator + 1)
	) {
		candidate = {
			oldPath: parseMarkerPath(content.slice(0, separator)),
			newPath: parseMarkerPath(content.slice(separator + 1)),
		};
		// For ordinary modifications, the diff header repeats the same path;
		// matching the two sides disambiguates filenames containing ` b/`.
		if (candidate.oldPath && candidate.oldPath === candidate.newPath) {
			return candidate;
		}
	}
	return candidate ?? {};
}

function quotedToken(input: string): string | undefined {
	if (!input.startsWith('"')) return undefined;
	let escaped = false;
	for (let index = 1; index < input.length; index++) {
		const character = input[index];
		if (escaped) {
			escaped = false;
		} else if (character === "\\") {
			escaped = true;
		} else if (character === '"') {
			return input.slice(0, index + 1);
		}
	}
	return undefined;
}

/** Read a JSON-serialized normalized diff from the shared cache row. */
export function parseCachedPrDiff(content: string): CachedPrDiff {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new PiOmpGitError(
			"GitHub cache contains an invalid PR diff representation.",
		);
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		typeof (parsed as CachedPrDiff).unifiedDiff !== "string" ||
		!Array.isArray((parsed as CachedPrDiff).files)
	) {
		throw new PiOmpGitError(
			"GitHub cache contains an invalid PR diff representation.",
		);
	}
	const diff = parsed as CachedPrDiff;
	for (const file of diff.files) {
		if (
			!Number.isInteger(file.index) ||
			typeof file.path !== "string" ||
			!Number.isInteger(file.startIndex) ||
			!Number.isInteger(file.endIndex) ||
			file.startIndex < 0 ||
			file.startIndex > file.endIndex ||
			(file.patchUnavailable !== undefined &&
				typeof file.patchUnavailable !== "boolean") ||
			file.endIndex > diff.unifiedDiff.length
		) {
			throw new PiOmpGitError(
				"GitHub cache contains an invalid PR diff representation.",
			);
		}
	}
	return diff;
}

/** Render `/diff`, `/diff/I`, or `/diff/all` from one cached object. */
export function renderPrDiff(
	diff: CachedPrDiff,
	pullNumber: number,
	fileIndex?: number | "all",
): string {
	if (fileIndex === "all") return diff.unifiedDiff;
	if (typeof fileIndex === "number") {
		const file = diff.files[fileIndex - 1];
		if (!file || file.index !== fileIndex) {
			throw new PiOmpGitError(
				`PR #${pullNumber} diff file index ${fileIndex} is out of range (1-${diff.files.length}).`,
			);
		}
		return diff.unifiedDiff.slice(file.startIndex, file.endIndex);
	}
	return renderDiffIndex(diff, pullNumber);
}

function renderDiffIndex(diff: CachedPrDiff, pullNumber: number): string {
	const lines = [
		`# PR #${pullNumber} diff`,
		"",
		`Changed files: ${diff.files.length}`,
	];
	if (diff.files.length === 0) {
		lines.push("", "*(no changed files)*");
		return lines.join("\n");
	}
	for (const file of diff.files) {
		const path = inlineCode(file.path);
		let description = file.changeType;
		if (file.changeType === "renamed" && file.oldPath) {
			description += ` from ${inlineCode(file.oldPath)}`;
		}
		if (file.binary) {
			description += " (binary)";
		} else if (file.additions !== undefined && file.deletions !== undefined) {
			description += ` (+${file.additions} -${file.deletions})`;
		}
		if (file.patchUnavailable) description += ` (${PATCH_UNAVAILABLE_MARKER})`;
		lines.push(`${file.index}. ${path} — ${description}`);
	}
	return lines.join("\n");
}

function inlineCode(value: string): string {
	return `\`${value.replaceAll("`", "\\`")}\``;
}
