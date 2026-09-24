/**
 * Revision inspection mode (docs/pi-omp-git-reference.md §67).
 *
 * A revision argument turns the `/git` UI read-only: the changed files
 * of one commit are listed, the diff shown is parent-versus-revision,
 * and every working-tree mutation is disabled. Large files above the
 * §68 limit show status instead of content, binary files are never
 * decoded, and Git LFS pointers are recognized so pointer text is not
 * misrepresented as content (§69).
 */

import { GitRepositoryError, PiOmpGitError } from "../shared/errors.ts";
import { type ParsedDiff, parseUnifiedDiff } from "./diff.ts";
import type { GitRunner } from "./runner.ts";
import {
	type FileDiff,
	type GitFile,
	MAX_DIFFABLE_FILE_BYTES,
} from "./status-model.ts";

/** The revision the TUI is inspecting. */
export interface RevisionInfo {
	/** The reference exactly as the user gave it. */
	ref: string;
	/** The resolved commit SHA. */
	commit: string;
	/** First parent SHA; absent for root commits (diff against empty tree). */
	parent?: string;
	/** The commit's subject line. */
	subject: string;
}

/** A revision-mode UI state: changed files of one commit, read-only. */
export interface RevisionUiState {
	root: string;
	revision: RevisionInfo;
	/** Changed files (A/M/D/R/C/T from diff-tree), newest side only. */
	files: GitFile[];
}

/** Resolve a revision to a commit, its parent, and subject (§67). */
export async function resolveRevision(
	deps: { git: GitRunner },
	cwd: string,
	ref: string,
): Promise<RevisionInfo> {
	const trimmed = ref.trim();
	if (!trimmed) {
		throw new PiOmpGitError("Provide a revision, e.g. /git HEAD~1.");
	}
	const commit = await runGit(
		deps,
		["rev-parse", "--verify", "--quiet", `${trimmed}^{commit}`],
		cwd,
	);
	if (commit.exitCode !== 0) {
		throw new GitRepositoryError(`Unknown revision: ${trimmed}`);
	}
	const sha = commit.stdout.trim();
	const parent = await runGit(
		deps,
		["rev-parse", "--quiet", "--verify", `${sha}^`],
		cwd,
	);
	const subject = await runGit(deps, ["log", "-1", "--format=%s", sha], cwd);
	return {
		ref: trimmed,
		commit: sha,
		...(parent.exitCode === 0 && parent.stdout.trim()
			? { parent: parent.stdout.trim() }
			: {}),
		subject: subject.stdout.trim(),
	};
}

/**
 * List the commit's changed files with name-status codes. One
 * `diff-tree` invocation covers both the root commit (`--root` diffs
 * against the empty tree) and normal commits (default diff against the
 * first parent).
 */
export async function collectRevisionStatus(
	deps: { git: GitRunner },
	cwd: string,
	info: RevisionInfo,
	options: { lfsProbe?: (path: string) => boolean } = {},
): Promise<RevisionUiState> {
	const rootResult = await runGit(deps, ["rev-parse", "--show-toplevel"], cwd);
	if (rootResult.exitCode !== 0) {
		throw new GitRepositoryError("Not inside a Git repository.");
	}
	const root = rootResult.stdout.trim();

	const names = await runGit(
		deps,
		["diff-tree", "-r", "--root", "--name-status", "--no-renames", info.commit],
		root,
	);
	if (names.exitCode !== 0) {
		throw new GitRepositoryError(
			`git diff-tree failed: ${(names.stderr || "").trim().slice(0, 300)}`,
		);
	}
	const files = parseRevisionNameStatus(names.stdout);

	const numstat = await runGit(
		deps,
		["diff-tree", "-r", "--root", "--numstat", info.commit],
		root,
	);
	if (numstat.exitCode === 0) {
		const binary = new Set(
			numstat.stdout
				.split("\n")
				.filter((line) => line.startsWith("-\t-\t"))
				.map((line) => line.slice(4).trim()),
		);
		for (const file of files) {
			if (
				binary.has(file.path) ||
				(file.origPath && binary.has(file.origPath))
			) {
				file.binary = true;
			}
		}
	}

	if (options.lfsProbe) {
		for (const file of files) {
			if (file.binary) continue;
			const content = await readBlobHead(deps, root, info.commit, file.path);
			if (content !== null && options.lfsProbe(content)) file.lfs = true;
		}
	}

	return { root, revision: info, files };
}

/** Parent-versus-revision diff for one file (§67). */
export async function fetchRevisionFileDiff(
	deps: { git: GitRunner },
	state: RevisionUiState,
	path: string,
): Promise<FileDiff> {
	const file = state.files.find((entry) => entry.path === path) ?? null;
	const empty: FileDiff = {
		path,
		side: "unstaged",
		binary: !!file?.binary,
		lfs: file?.lfs,
		oversized: false,
		empty: true,
	};
	if (!file) return empty;
	if (file.binary) return empty;

	// Oversize check before loading content (§68): both blobs involved.
	const commitSize = await blobSize(
		deps,
		state.root,
		`${state.revision.commit}:${path}`,
	);
	const parentSize = state.revision.parent
		? await blobSize(deps, state.root, `${state.revision.parent}:${path}`)
		: null;
	if (oversized(commitSize) || oversized(parentSize)) {
		return { ...empty, oversized: true, empty: false };
	}

	// `diff-tree -p` renders the same patch shape as git diff for root
	// commits (empty-tree comparison) and normal commits alike.
	const diff = await runGit(
		deps,
		[
			"diff-tree",
			"-p",
			"--root",
			"--format=",
			state.revision.commit,
			"--",
			path,
		],
		state.root,
	);
	if (diff.exitCode !== 0) {
		throw new GitRepositoryError(
			`git diff-tree failed: ${(diff.stderr || "").trim().slice(0, 300)}`,
		);
	}
	const text = diff.stdout;
	if (text.trim() === "") return empty;
	const parsed: ParsedDiff = parseUnifiedDiff(text);
	return {
		path,
		side: "unstaged",
		text,
		parsed,
		binary: false,
		lfs: file.lfs,
		oversized: false,
		empty: false,
	};
}

/**
 * Parse `diff-tree --name-status` output: `M<TAB>path`, `A<TAB>path`,
 * `D<TAB>path`, `T<TAB>path`. The leading commit-SHA line carries no
 * tab and is skipped.
 */
export function parseRevisionNameStatus(output: string): GitFile[] {
	const files: GitFile[] = [];
	for (const line of output.split("\n")) {
		if (line.trim() === "") continue;
		const [status, ...pathParts] = line.split("\t");
		const path = pathParts.join("\t");
		if (!path || !status) continue;
		const code = status.trim();
		if (!["A", "M", "D", "T"].includes(code)) continue;
		files.push({ path, state: code as GitFile["state"] });
	}
	return files;
}

function oversized(size: number | null): boolean {
	return size !== null && size > MAX_DIFFABLE_FILE_BYTES;
}

async function blobSize(
	deps: { git: GitRunner },
	root: string,
	spec: string,
): Promise<number | null> {
	const result = await deps.git.run(["cat-file", "-s", spec], { cwd: root });
	if (result.exitCode !== 0) return null;
	const size = Number(result.stdout.trim());
	return Number.isFinite(size) ? size : null;
}

/** First bytes of a revision blob, for LFS pointer recognition (§69). */
async function readBlobHead(
	deps: { git: GitRunner },
	root: string,
	commit: string,
	path: string,
): Promise<string | null> {
	const size = await blobSize(deps, root, `${commit}:${path}`);
	if (size === null || size > MAX_DIFFABLE_FILE_BYTES) return null;
	const content = await deps.git.run(["cat-file", "-p", `${commit}:${path}`], {
		cwd: root,
	});
	if (content.exitCode !== 0) return null;
	return content.stdout.slice(0, 200);
}

async function runGit(
	deps: { git: GitRunner },
	args: string[],
	cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	return deps.git.run(args, { cwd });
}
