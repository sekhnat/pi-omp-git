/**
 * Headless Git UI state model (docs/pi-omp-git-reference.md §62–§63,
 * §68–§69, ticket 17).
 *
 * The model is built from Git plumbing output — status porcelain v2,
 * numstat, blob sizes — and is testable without a terminal. The TUI is
 * a view over this model; state is re-read from Git after every
 * mutation, never inferred from process exit text.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GitRepositoryError } from "../shared/errors.ts";
import { type ParsedDiff, parseUnifiedDiff } from "./diff.ts";
import type { GitRunner } from "./runner.ts";

/** Git file state codes (porcelain v2 X/Y positions, §63). */
export type FileState = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?";

export interface GitFile {
	path: string;
	/** Original path for renames (R) and copies (C). */
	origPath?: string;
	state: FileState;
	/** Either side of the change is binary (numstat "- -"). */
	binary?: boolean;
	/** The file content is a Git LFS pointer (§69). */
	lfs?: boolean;
}

export interface GitSelection {
	area: "staged" | "unstaged" | "conflicts";
	file?: string;
	hunk?: number;
}

/** §62 explicit state model. */
export interface GitUiState {
	root: string;
	branch?: string;
	head?: string;
	staged: GitFile[];
	unstaged: GitFile[];
	conflicts: GitFile[];
	selection: GitSelection;
	revision?: string;
}

/** Parity limit for interactive diffable files (§68). */
export const MAX_DIFFABLE_FILE_BYTES = 4 * 1024 * 1024;

export interface StatusDeps {
	git: GitRunner;
}

/** Raw repository facts the model is built from (all collected up front). */
export interface GitRawStatus {
	root: string;
	branch?: string;
	head?: string;
	/** Lines of `git status --porcelain=v2 --branch` (without '#' branch lines handled separately). */
	statusLines: string[];
	/** `git diff --numstat` lines (unstaged). */
	unstagedNumstat: string[];
	/** `git diff --cached --numstat` lines (staged). */
	stagedNumstat: string[];
}

export function unquoteGitPath(path: string): string {
	if (!path.startsWith('"')) return path;
	const body = path.slice(1, -1);
	return body.replace(/\\(?:\\|"|n|t|[0-7]{3})/g, (esc) => {
		if (esc === "\\\\") return "\\";
		if (esc === '\\"') return '"';
		if (esc === "\\n") return "\n";
		if (esc === "\\t") return "\t";
		return String.fromCharCode(parseInt(esc.slice(1), 8));
	});
}

/**
 * Parse `git status --porcelain=v2 --branch` output into per-path
 * entries plus branch/head metadata.
 */
export function parseStatusV2(output: string): {
	branch?: string;
	head?: string;
	staged: GitFile[];
	unstaged: GitFile[];
	conflicts: GitFile[];
} {
	const staged: GitFile[] = [];
	const unstaged: GitFile[] = [];
	const conflicts: GitFile[] = [];
	let branch: string | undefined;
	let head: string | undefined;

	for (const rawLine of output.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line === "") continue;
		if (line.startsWith("# ")) {
			const [key, value] = line.slice(2).split(" ", 2);
			if (key === "branch.head" && value && value !== "(detached)") {
				branch = value;
			}
			if (key === "branch.oid" && value && value !== "(initial)") {
				head = value;
			}
			continue;
		}
		const kind = line.slice(0, 1);
		if (kind === "?") {
			const path = unquoteGitPath(line.slice(2));
			unstaged.push({ path, state: "?" });
			continue;
		}
		if (kind === "!") continue; // ignored files
		if (kind === "u") {
			const rest = line.slice(2).split(" ");
			// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
			const path = unquoteGitPath(rest.slice(9).join(" "));
			conflicts.push({ path, state: "U" });
			continue;
		}
		if (kind !== "1" && kind !== "2") continue;

		const parts = line.split(" ");
		const xy = parts[1] ?? "..";
		const x = xy.slice(0, 1);
		const y = xy.slice(1, 2);
		if (kind === "2") {
			// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
			const tab = line.indexOf("\t");
			const meta = tab >= 0 ? line.slice(0, tab) : line;
			const scoreToken = meta.split(" ")[8] ?? "";
			const scoreAt = scoreToken === "" ? -1 : meta.indexOf(scoreToken);
			const path = unquoteGitPath(
				scoreAt >= 0 ? meta.slice(scoreAt + scoreToken.length + 1) : "",
			);
			const origPath =
				tab >= 0 ? unquoteGitPath(line.slice(tab + 1)) : undefined;
			const state = (scoreToken.slice(0, 1) || "?") as FileState;
			if (x !== ".") {
				staged.push({ path, origPath, state });
			}
			if (y !== ".") {
				unstaged.push({ path, origPath, state: y as FileState });
			}
		} else {
			const path = unquoteGitPath(parts.slice(8).join(" "));
			if (x !== ".") staged.push({ path, state: x as FileState });
			if (y !== ".") unstaged.push({ path, state: y as FileState });
		}
	}
	return { branch, head, staged, unstaged, conflicts };
}

/** Extract binary file paths from `git diff --numstat` output ("-\t-\tpath"). */
export function parseBinaryPaths(numstat: string[]): Set<string> {
	const binary = new Set<string>();
	for (const line of numstat) {
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		if (parts[0] === "-" && parts[1] === "-") {
			binary.add(unquoteGitPath(parts.slice(2).join("\t")));
		}
	}
	return binary;
}

const LFS_POINTER_PREFIX = "version https://git-lfs";
const LFS_OID_PATTERN = /oid sha256:[0-9a-f]{64}/;

export function isLfsPointerContent(text: string): boolean {
	return text.startsWith(LFS_POINTER_PREFIX) && LFS_OID_PATTERN.test(text);
}

function readFileHead(path: string, bytes = 400): string | null {
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > 64 * 1024) return null;
		const fd = readFileSync(path);
		return fd.subarray(0, bytes).toString("utf8");
	} catch {
		return null;
	}
}

/**
 * Build the UI state from raw repository facts. LFS pointer detection
 * needs file contents, which the caller provides for the worktree side.
 */
export function buildGitUiState(
	raw: GitRawStatus,
	options: {
		selection?: GitSelection;
		lfsProbe?: (path: string) => boolean;
	} = {},
): GitUiState {
	const { branch, head, staged, unstaged, conflicts } = parseStatusV2(
		raw.statusLines.join("\n"),
	);
	const stagedBinary = parseBinaryPaths(raw.stagedNumstat);
	const unstagedBinary = parseBinaryPaths(raw.unstagedNumstat);
	for (const file of staged) {
		if (
			stagedBinary.has(file.path) ||
			(file.origPath && stagedBinary.has(file.origPath))
		) {
			file.binary = true;
		}
	}
	for (const file of unstaged) {
		if (
			unstagedBinary.has(file.path) ||
			(file.origPath && unstagedBinary.has(file.origPath))
		) {
			file.binary = true;
		}
	}
	if (options.lfsProbe) {
		for (const file of [...staged, ...unstaged, ...conflicts]) {
			if (options.lfsProbe(join(raw.root, file.path))) file.lfs = true;
		}
	}
	return {
		root: raw.root,
		branch,
		head,
		staged,
		unstaged,
		conflicts,
		selection: options.selection ?? { area: "unstaged" },
	};
}

/** An empty worktree state; used as the inert base for revision mode. */
export function emptyGitUiState(root: string): GitUiState {
	return {
		root,
		staged: [],
		unstaged: [],
		conflicts: [],
		selection: { area: "unstaged" },
	};
}

/**
 * Collect raw repository facts with real git. All git invocation lives
 * here so tests can either run real git or feed collected raw output to
 * `buildGitUiState` directly.
 */
export async function collectGitRawStatus(
	deps: StatusDeps,
	cwd: string,
): Promise<GitRawStatus> {
	const rootResult = await deps.git.run(["rev-parse", "--show-toplevel"], {
		cwd,
	});
	if (rootResult.exitCode !== 0) {
		throw new GitRepositoryError("Not inside a Git repository.");
	}
	const root = rootResult.stdout.trim();
	const status = await deps.git.run(
		["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
		{ cwd: root },
	);
	if (status.exitCode !== 0) {
		throw new GitRepositoryError(
			`git status failed: ${(status.stderr || status.stdout).trim().slice(0, 300)}`,
		);
	}
	const [unstagedNumstat, stagedNumstat] = await Promise.all([
		deps.git.run(["diff", "--numstat"], { cwd: root }),
		deps.git.run(["diff", "--cached", "--numstat"], { cwd: root }),
	]);
	return {
		root,
		statusLines: status.stdout.split("\n"),
		unstagedNumstat: unstagedNumstat.stdout.split("\n"),
		stagedNumstat: stagedNumstat.stdout.split("\n"),
	};
}

/** Refresh the full UI state from Git (used after every mutation). */
export async function refreshGitState(
	deps: StatusDeps,
	cwd: string,
	selection?: GitSelection,
): Promise<GitUiState> {
	const raw = await collectGitRawStatus(deps, cwd);
	const state = buildGitUiState(raw, {
		selection,
		lfsProbe: (path) => {
			const content = readFileHead(path);
			return content !== null && isLfsPointerContent(content);
		},
	});
	return state;
}

export interface FileDiff {
	path: string;
	side: "staged" | "unstaged";
	/** Parsed diff when textual. */
	parsed?: ParsedDiff;
	/** Raw diff text when textual. */
	text?: string;
	binary: boolean;
	lfs?: boolean;
	oversized: boolean;
	/** True when the file has no changes on this side. */
	empty: boolean;
}

function blobOversized(fileSize: number | null): boolean {
	return fileSize !== null && fileSize > MAX_DIFFABLE_FILE_BYTES;
}

/**
 * Fetch the diff for one file side. Untracked files use
 * `git diff --no-index /dev/null <path>` (exit code 1 carries the diff).
 * Files above the §68 limit are reported oversized without loading
 * content.
 */
export async function fetchFileDiff(
	deps: StatusDeps,
	state: GitUiState,
	side: "staged" | "unstaged",
	path: string,
): Promise<FileDiff> {
	const file =
		[...(side === "staged" ? state.staged : state.unstaged)].find(
			(entry) => entry.path === path,
		) ?? null;
	if (!file) {
		return { path, side, binary: false, oversized: false, empty: true };
	}
	if (side === "staged" && file.state === "?") {
		return { path, side, binary: false, oversized: false, empty: true };
	}

	const empty: FileDiff = {
		path,
		side,
		binary: !!file.binary,
		lfs: file.lfs,
		oversized: false,
		empty: true,
	};

	if (file.binary) {
		return empty;
	}

	// Oversize check before loading content (§68): every blob involved in
	// the requested diff must stay within the parity limit.
	const stagedSide = side === "staged";
	if (stagedSide) {
		const indexSize = await blobSize(deps, state.root, `:${path}`);
		const headSize = await blobSize(
			deps,
			state.root,
			`${state.head ?? "HEAD"}:${path}`,
		);
		if (blobOversized(indexSize) || blobOversized(headSize)) {
			return { ...empty, oversized: true, empty: false };
		}
	} else {
		let worktreeSize: number | null = null;
		try {
			worktreeSize = statSync(join(state.root, path)).size;
		} catch {
			worktreeSize = null;
		}
		if (blobOversized(worktreeSize)) {
			return { ...empty, oversized: true, empty: false };
		}
		const indexSize = await blobSize(deps, state.root, `:${path}`);
		if (blobOversized(indexSize)) {
			return { ...empty, oversized: true, empty: false };
		}
	}

	let diffResult: Awaited<ReturnType<GitRunner["run"]>>;
	if (stagedSide) {
		diffResult = await deps.git.run(["diff", "--cached", "--", path], {
			cwd: state.root,
		});
	} else if (file.state === "?") {
		diffResult = await deps.git.run(
			["diff", "--no-index", "--", "/dev/null", path],
			{ cwd: state.root },
		);
		if ((diffResult.exitCode ?? 99) > 1) {
			throw new GitRepositoryError(
				`git diff failed: ${(diffResult.stderr || "").trim().slice(0, 300)}`,
			);
		}
	} else {
		diffResult = await deps.git.run(["diff", "--", path], { cwd: state.root });
	}
	const exitCode = diffResult.exitCode ?? 99;
	if (exitCode !== 0 && !(file.state === "?" && exitCode === 1)) {
		throw new GitRepositoryError(
			`git diff failed: ${(diffResult.stderr || diffResult.stdout).trim().slice(0, 300)}`,
		);
	}
	const text = diffResult.stdout;
	if (text.trim() === "") {
		return empty;
	}
	return {
		path,
		side,
		text,
		parsed: parseUnifiedDiff(text),
		binary: false,
		lfs: file.lfs,
		oversized: false,
		empty: false,
	};
}

async function blobSize(
	deps: StatusDeps,
	root: string,
	spec: string,
): Promise<number | null> {
	const result = await deps.git.run(["cat-file", "-s", spec], { cwd: root });
	if (result.exitCode !== 0) return null;
	const size = Number(result.stdout.trim());
	return Number.isFinite(size) ? size : null;
}
