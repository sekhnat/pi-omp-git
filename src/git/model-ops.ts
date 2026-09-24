/**
 * Git TUI file- and hunk-level operations (docs/pi-omp-git-reference.md
 * §64–§66, ticket 18).
 *
 * Every mutation runs through Git; the caller refreshes state from Git
 * afterwards — success is never inferred from process exit text. Hunk
 * operations use generated single-hunk patches that are validated with
 * `git apply --check` before application, and the post-application
 * repository state is verified by re-reading the relevant diff (the
 * hunk's changed-line body must occur exactly one fewer time): a hunk
 * that did not land is surfaced as a failure, never reported as
 * success. Conflicted files are protected from ordinary operations.
 */

import {
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitMutationError } from "../shared/errors.ts";
import {
	countHunkBodies,
	extractHunkPatch,
	hunkBody,
	parseUnifiedDiff,
} from "./diff.ts";
import type { GitRunner } from "./runner.ts";
import type { GitFile, GitUiState } from "./status-model.ts";

export interface OpsDeps {
	git: GitRunner;
	/** Repository root — every operation runs with this as cwd. */
	root: string;
	/** Directory for transient patch files (default: OS temp dir). */
	tmpDir?: string;
}

async function git(
	deps: OpsDeps,
	args: string[],
	expectSuccess = true,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const result = await deps.git.run(args, { cwd: deps.root });
	if (expectSuccess && result.exitCode !== 0) {
		throw new GitMutationError(
			`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
		);
	}
	return result;
}

function findFile(
	state: Pick<GitUiState, "staged" | "unstaged" | "conflicts">,
	area: "staged" | "unstaged" | "conflicts",
	path: string,
): GitFile {
	const list =
		area === "staged"
			? state.staged
			: area === "unstaged"
				? state.unstaged
				: state.conflicts;
	const file = list.find((entry) => entry.path === path);
	if (!file) {
		throw new GitMutationError(
			`No ${area} entry for ${path} — the repository state changed; refresh and retry.`,
		);
	}
	return file;
}

/** Conflicted files are protected from ordinary operations (§64). */
function assertNotConflicted(state: GitUiState, path: string): void {
	if (state.conflicts.some((entry) => entry.path === path)) {
		throw new GitMutationError(
			`${path} has unresolved merge conflicts — resolve the conflict before staging or discarding.`,
		);
	}
}

function pathsFor(file: GitFile): string[] {
	return file.origPath ? [file.path, file.origPath] : [file.path];
}

// ---------------------------------------------------------------------------
// File-level operations (§64)
// ---------------------------------------------------------------------------

/** Stage an unstaged (or untracked) file selected from current state. */
export async function stageFilePath(
	deps: OpsDeps,
	state: GitUiState,
	path: string,
): Promise<void> {
	assertNotConflicted(state, path);
	const file = findFile(state, "unstaged", path);
	await git(deps, ["add", "-A", "--", ...pathsFor(file)]);
}

/** Unstage a staged file, keeping worktree content. */
export async function unstageFilePath(
	deps: OpsDeps,
	state: GitUiState,
	path: string,
): Promise<void> {
	assertNotConflicted(state, path);
	const file = findFile(state, "staged", path);
	await git(deps, ["restore", "--staged", "--", ...pathsFor(file)]);
}

/**
 * Warning that must be shown before "discard all changes in file"
 * (§66): when the staged file also carries unstaged modifications,
 * those are lost too.
 */
export function discardAllWarning(
	state: GitUiState,
	path: string,
): string | null {
	const staged = state.staged.some((entry) => entry.path === path);
	const unstaged = state.unstaged.some((entry) => entry.path === path);
	if (staged && unstaged) {
		return `Discard all changes in ${path}? Unstaged modifications to the same path will also be lost.`;
	}
	return null;
}

/**
 * "Discard all changes in file" (§66): restore the index to HEAD and
 * the working tree appropriately; files not present in HEAD end up
 * untracked and are removed (the action is an explicit discard-all).
 */
export async function discardStagedFile(
	deps: OpsDeps,
	state: GitUiState,
	path: string,
): Promise<void> {
	assertNotConflicted(state, path);
	const file = findFile(state, "staged", path);
	if (file.state === "A") {
		// Not in HEAD: unstage (the file leaves the index), then remove the
		// now-untracked worktree file — this is the explicit discard-all.
		await git(deps, ["restore", "--staged", "--", ...pathsFor(file)]);
		removeWorktreeFile(deps, file.path);
		return;
	}
	// In HEAD: restore both index and worktree to HEAD.
	await git(deps, [
		"restore",
		"--source=HEAD",
		"--staged",
		"--worktree",
		"--",
		...pathsFor(file),
	]);
}

/**
 * Discard an unstaged file's changes: tracked files are restored from
 * the index (keeping any staged changes); untracked files are deleted
 * from the worktree.
 */
export async function discardUnstagedFile(
	deps: OpsDeps,
	state: GitUiState,
	path: string,
): Promise<void> {
	assertNotConflicted(state, path);
	const file = findFile(state, "unstaged", path);
	if (file.state === "?") {
		removeWorktreeFile(deps, file.path);
		return;
	}
	await git(deps, ["restore", "--", file.path]);
}

function removeWorktreeFile(deps: OpsDeps, path: string): void {
	const target = join(deps.root, path);
	try {
		statSync(target);
	} catch {
		return; // already gone
	}
	try {
		rmSync(target, { force: true });
	} catch (error) {
		throw new GitMutationError(
			`Could not delete ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Hunk-level operations (§65)
// ---------------------------------------------------------------------------

async function readDiff(deps: OpsDeps, args: string[]): Promise<string> {
	const result = await git(deps, args, false);
	const exitCode = result.exitCode ?? 99;
	if (exitCode !== 0 && exitCode !== 1) {
		throw new GitMutationError(
			`git diff failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
		);
	}
	return result.stdout;
}

/** Verify a hunk left the source diff: its body must occur one fewer time. */
async function verifyHunkApplied(
	deps: OpsDeps,
	diffArgs: string[],
	expectedBody: string,
	previousCount: number,
	action: string,
): Promise<void> {
	const after = await readDiff(deps, diffArgs);
	const afterCount = countHunkBodies(after, expectedBody);
	if (afterCount !== previousCount - 1) {
		throw new GitMutationError(
			`${action}: the hunk did not apply cleanly (matching hunks before: ${previousCount}, after: ${afterCount}).`,
		);
	}
}

interface HunkPatch {
	patch: string;
	body: string;
	previousCount: number;
}

function buildHunkPatch(
	diff: string,
	hunkIndex: number,
	sourceDescription: string,
): HunkPatch {
	const body = hunkBody(diff, hunkIndex);
	if (body === "") {
		throw new GitMutationError(`No hunk ${hunkIndex} in ${sourceDescription}.`);
	}
	return {
		patch: extractHunkPatch(diff, hunkIndex),
		body,
		previousCount: countHunkBodies(diff, body),
	};
}

/** Validate with `git apply --check`, then apply. Rejections are surfaced. */
async function checkAndApply(
	deps: OpsDeps,
	patch: string,
	applyArgs: string[],
	action: string,
): Promise<void> {
	const patchPath = writePatchFile(deps, patch);
	try {
		const check = await git(
			deps,
			[...applyArgs, "--check", "--whitespace=nowarn", patchPath],
			false,
		);
		if (check.exitCode !== 0) {
			throw new GitMutationError(
				`${action} rejected by Git: ${(check.stderr || check.stdout).trim().slice(0, 300)}`,
			);
		}
		await git(deps, [...applyArgs, "--whitespace=nowarn", patchPath]);
	} finally {
		removePatchFile(patchPath);
	}
}

/** Stage exactly one hunk of a file's unstaged diff (§65). */
export async function stageFileHunk(
	deps: OpsDeps,
	state: GitUiState,
	path: string,
	hunkIndex: number,
): Promise<void> {
	assertNotConflicted(state, path);
	const { patch, body, previousCount } = buildHunkPatch(
		await readDiff(deps, ["diff", "--", path]),
		hunkIndex,
		`the unstaged diff of ${path}`,
	);
	await checkAndApply(deps, patch, ["apply", "--cached"], "Stage hunk");
	await verifyHunkApplied(
		deps,
		["diff", "--", path],
		body,
		previousCount,
		"Stage hunk",
	);
}

/** Unstage exactly one hunk of a file's staged diff (§65). */
export async function unstageFileHunk(
	deps: OpsDeps,
	state: GitUiState,
	path: string,
	hunkIndex: number,
): Promise<void> {
	assertNotConflicted(state, path);
	const { patch, body, previousCount } = buildHunkPatch(
		await readDiff(deps, ["diff", "--cached", "--", path]),
		hunkIndex,
		`the staged diff of ${path}`,
	);
	await checkAndApply(
		deps,
		patch,
		["apply", "--cached", "--reverse"],
		"Unstage hunk",
	);
	await verifyHunkApplied(
		deps,
		["diff", "--cached", "--", path],
		body,
		previousCount,
		"Unstage hunk",
	);
}

/** Discard exactly one hunk of a file's unstaged diff (worktree reverse-apply). */
export async function discardFileHunk(
	deps: OpsDeps,
	state: GitUiState,
	path: string,
	hunkIndex: number,
): Promise<void> {
	assertNotConflicted(state, path);
	const file = findFile(state, "unstaged", path);
	if (file.state === "?") {
		await discardHunkUntracked(deps, path, hunkIndex);
		return;
	}
	const { patch, body, previousCount } = buildHunkPatch(
		await readDiff(deps, ["diff", "--", path]),
		hunkIndex,
		`the unstaged diff of ${path}`,
	);
	await checkAndApply(deps, patch, ["apply", "--reverse"], "Discard hunk");
	await verifyHunkApplied(
		deps,
		["diff", "--", path],
		body,
		previousCount,
		"Discard hunk",
	);
}

/**
 * Stage exactly one hunk of an untracked file. The untracked diff comes
 * from `git diff --no-index`; the same validated patch primitive stages
 * exactly those lines.
 */
export async function stageFileHunkUntracked(
	deps: OpsDeps,
	path: string,
	hunkIndex: number,
): Promise<void> {
	const { patch, body } = buildHunkPatch(
		await readDiff(deps, ["diff", "--no-index", "--", "/dev/null", path]),
		hunkIndex,
		`the diff of ${path}`,
	);
	await checkAndApply(deps, patch, ["apply", "--cached"], "Stage hunk");
	// The worktree is unchanged by staging, so verify against the staged
	// diff: the hunk's body must now appear exactly once there.
	const stagedAfter = await readDiff(deps, ["diff", "--cached", "--", path]);
	if (countHunkBodies(stagedAfter, body) !== 1) {
		throw new GitMutationError(
			"Stage hunk: the hunk did not apply cleanly — the staged diff does not contain it.",
		);
	}
}

/**
 * Discard one hunk of an untracked file: the file's content is exactly
 * its added lines, so discarding one hunk rewrites the file with every
 * other hunk's added lines; an empty result removes the file. Verified
 * by re-reading the resulting content.
 */
async function discardHunkUntracked(
	deps: OpsDeps,
	path: string,
	hunkIndex: number,
): Promise<void> {
	const diff = await readDiff(deps, [
		"diff",
		"--no-index",
		"--",
		"/dev/null",
		path,
	]);
	const parsed = parseUnifiedDiff(diff);
	const hunk = parsed.hunks[hunkIndex];
	if (!hunk) {
		throw new GitMutationError(`No hunk ${hunkIndex} in the diff of ${path}.`);
	}
	const kept = parsed.hunks
		.filter((_, index) => index !== hunkIndex)
		.flatMap((candidate) =>
			candidate.lines
				.filter((line) => line.kind === "add")
				.map((line) => line.text),
		);
	const target = join(deps.root, path);
	const next = kept.length === 0 ? "" : `${kept.join("\n")}\n`;
	if (next === "") {
		removeWorktreeFile(deps, path);
		return;
	}
	try {
		writeFileSync(target, next);
	} catch (error) {
		throw new GitMutationError(
			`Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const after = readWorktreeFileOrNull(target);
	if (after === null || after !== next) {
		throw new GitMutationError(
			`Discard hunk: ${path} did not end up with the intended content.`,
		);
	}
}

function readWorktreeFileOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

// Transient patch files live outside the worktree so they never show up
// in status output.
const PATCH_DIR_NAME = "pi-omp-git-patches";

function patchDir(deps: OpsDeps): string {
	const base = deps.tmpDir ?? tmpdir();
	return join(base, PATCH_DIR_NAME);
}

function writePatchFile(deps: OpsDeps, patch: string): string {
	const dir = patchDir(deps);
	mkdirSync(dir, { recursive: true });
	const patchPath = join(
		dir,
		`patch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`,
	);
	writeFileSync(patchPath, patch, { mode: 0o600 });
	return patchPath;
}

function removePatchFile(patchPath: string): void {
	try {
		rmSync(patchPath, { force: true });
	} catch {
		// best-effort cleanup
	}
}
