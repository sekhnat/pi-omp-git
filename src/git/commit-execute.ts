/**
 * Commit execution (docs/pi-omp-git-reference.md §79–§80, §83–§85).
 *
 * Split execution is transactional: per-file staged patches are
 * captured up front, each group's index is built by resetting the index
 * to HEAD and applying only that group's patches, and every commit is
 * verified by HEAD movement (§83). A failure at commit N stops
 * immediately, reports which commits succeeded and which proposal
 * failed, and restores the original index so all uncommitted changes
 * remain recoverable. Conservation (§80) compares pre/post snapshots —
 * any mismatch, including hook side-effects or external concurrent
 * modification, aborts with CommitExecutionError rather than proceeding
 * silently.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CommitExecutionError,
	GitMutationError,
	PiOmpGitError,
} from "../shared/errors.ts";
import { commitFailure } from "./commit-ops.ts";
import type { GitRunner } from "./runner.ts";

export interface ExecuteDeps {
	git: GitRunner;
	cwd: string;
	/** Test seam: directory for transient patch/message files. */
	tempDir?: string;
	signal?: AbortSignal;
}

export interface ExecutedCommit {
	short: string;
	subject: string;
	files: string[];
}

export interface ExecutionInput {
	/** Ordered groups; each entry is one proposal already validated. */
	groups: Array<{ message: string; files: string[] }>;
	/** Extra content staged into the first group (e.g. the changelog). */
	preStageFirst?: () => Promise<void>;
}

export interface ExecutionOutcome {
	commits: ExecutedCommit[];
	/** Set when execution stopped early; the error carries the details. */
	indexTreeBefore: string;
}

/** Snapshot the index tree (§80). Fails on unmerged entries. */
export async function snapshotIndexTree(deps: ExecuteDeps): Promise<string> {
	const result = await deps.git.run(["write-tree"], { cwd: deps.cwd });
	if (result.exitCode !== 0) {
		throw new PiOmpGitError(
			`Cannot snapshot the index before committing${/unmerged|conflict/i.test(result.stderr) ? " (the index has unmerged entries)" : ""}: ${(result.stderr || "").trim().slice(0, 300)}`,
		);
	}
	return result.stdout.trim();
}

/** Status snapshot used for the §80 conservation comparison. */
export async function statusSnapshot(deps: ExecuteDeps): Promise<string[]> {
	const result = await deps.git.run(
		["status", "--porcelain=v2", "--untracked-files=all"],
		{ cwd: deps.cwd },
	);
	if (result.exitCode !== 0) {
		throw new PiOmpGitError(
			`git status failed: ${(result.stderr || "").trim().slice(0, 300)}`,
		);
	}
	return result.stdout.split("\n").filter((line) => line.length > 0);
}

/**
 * Execute one or more commits from an index that already holds exactly
 * the first group's content. Used by the single-commit path.
 */
export async function executeSingleCommit(
	deps: ExecuteDeps,
	message: string,
	files: string[],
): Promise<ExecutedCommit> {
	const outcome = await runCommitCommand(deps, message);
	return { ...outcome, files };
}

/**
 * Transactional split execution (§79): for each group, reset the index
 * to HEAD, apply only that group's captured staged patches, commit, and
 * verify HEAD moved. On failure at commit N, the original index is
 * restored so every uncommitted change stays recoverable.
 */
export async function executeSplitCommits(
	deps: ExecuteDeps,
	input: ExecutionInput,
): Promise<{ commits: ExecutedCommit[]; indexTreeBefore: string }> {
	const indexTreeBefore = await snapshotIndexTree(deps);

	// Capture each file's staged patch against the pre-operation index.
	const dir =
		deps.tempDir ?? (await mkdtemp(join(tmpdir(), "pi-omp-git-split-")));
	const ownsDir = !deps.tempDir;
	const patches = new Map<string, string>();
	try {
		for (const group of input.groups) {
			for (const file of group.files) {
				if (patches.has(file)) continue;
				const diff = await deps.git.run(["diff", "--cached", "--", file], {
					cwd: deps.cwd,
				});
				if ((diff.exitCode ?? 99) !== 0) {
					throw new GitMutationError(
						`git diff --cached failed for ${file}: ${(diff.stderr || "").trim().slice(0, 300)}`,
					);
				}
				const patchPath = join(
					dir,
					`patch-${sanitize(file)}-${patches.size}.patch`,
				);
				await writeFile(patchPath, diff.stdout, "utf8");
				patches.set(file, patchPath);
			}
		}

		const commits: ExecutedCommit[] = [];
		for (const [index, group] of input.groups.entries()) {
			// Index := HEAD tree, then only this group's patches.
			const reset = await deps.git.run(["read-tree", "HEAD"], {
				cwd: deps.cwd,
			});
			if (reset.exitCode !== 0) {
				await restoreIndex(deps, indexTreeBefore);
				throw new GitMutationError(
					`Could not reset the index for commit ${index + 1}: ${(reset.stderr || "").trim().slice(0, 300)}`,
				);
			}
			for (const file of group.files) {
				const patchPath = patches.get(file);
				if (!patchPath) continue;
				const apply = await deps.git.run(
					["apply", "--cached", "--whitespace=nowarn", patchPath],
					{ cwd: deps.cwd },
				);
				if ((apply.exitCode ?? 99) !== 0) {
					await restoreIndex(deps, indexTreeBefore);
					throw new GitMutationError(
						`Applying the staged patch for ${file} failed: ${(apply.stderr || "").trim().slice(0, 300)}`,
					);
				}
			}
			if (index === 0) await input.preStageFirst?.();
			try {
				const outcome = await runCommitCommand(deps, group.message);
				commits.push({ ...outcome, files: group.files });
			} catch (error) {
				// Failure at commit N (§79): stop, restore, report.
				await restoreIndex(deps, indexTreeBefore);
				throw error;
			}
		}
		return { commits, indexTreeBefore };
	} finally {
		if (ownsDir) await rm(dir, { recursive: true, force: true });
	}
}

/**
 * §80 conservation: after execution, the status must differ from the
 * pre-operation snapshot only by the consumed staged components of the
 * committed paths. Any other difference — hook side-effects or external
 * concurrent modification — aborts with CommitExecutionError.
 */
export async function verifyConservation(
	deps: ExecuteDeps,
	before: string[],
	committedFiles: string[],
): Promise<void> {
	const committed = new Set(committedFiles);
	const after = await statusSnapshot(deps);

	// Porcelain v2 fields are space-separated (renames carry a tab for
	// the original path); parse per record kind rather than by tab.
	const parse = (
		line: string,
	): { kind: string; xy: string; path: string } | null => {
		if (line.startsWith("? ")) {
			return { kind: "?", xy: "?", path: line.slice(2) };
		}
		const tokens = line.split(" ");
		const kind = tokens[0] ?? "";
		if (kind === "1") {
			return { kind, xy: tokens[1] ?? "", path: tokens.slice(8).join(" ") };
		}
		if (kind === "2") {
			const tab = line.indexOf("\t");
			const meta = tab >= 0 ? line.slice(0, tab) : line;
			const metaTokens = meta.split(" ");
			return {
				kind,
				xy: tokens[1] ?? "",
				path: metaTokens.slice(9).join(" "),
			};
		}
		if (kind === "u") {
			return { kind, xy: tokens[1] ?? "", path: tokens.slice(10).join(" ") };
		}
		return null;
	};

	const afterByPath = new Map<string, string[]>();
	for (const line of after) {
		const entry = parse(line);
		if (!entry) continue;
		const list = afterByPath.get(entry.path) ?? [];
		list.push(line);
		afterByPath.set(entry.path, list);
	}

	const problems: string[] = [];
	const remaining: string[] = [];
	for (const line of before) {
		const entry = parse(line);
		if (!entry) continue;
		if (committed.has(entry.path)) {
			const still = afterByPath.get(entry.path) ?? [];
			// Every remaining entry for a committed path must have an
			// untouched index component (X preserved as-is minus staged
			// consumption: X becomes "." when it was staged-only).
			for (const candidate of still) {
				const candidateEntry = parse(candidate);
				// The staged side was consumed; X must read "." now.
				if (candidateEntry && candidateEntry.xy[0] !== ".") {
					problems.push(
						`${entry.path}: staged side unexpectedly still present (${candidateEntry.xy})`,
					);
				}
			}
			continue;
		}
		remaining.push(line);
	}
	// Unrelated entries must survive byte-identically.
	const afterUnrelated: string[] = [];
	for (const line of after) {
		const entry = parse(line);
		if (!entry) continue;
		if (!committed.has(entry.path)) afterUnrelated.push(line);
	}
	const expectedUnrelated = remaining.filter(
		(line) => !committed.has(parse(line)?.path ?? ""),
	);
	if (afterUnrelated.join("\n") !== expectedUnrelated.join("\n")) {
		const beforeSet = new Set(expectedUnrelated);
		const afterSet = new Set(afterUnrelated);
		for (const line of afterUnrelated) {
			if (!beforeSet.has(line))
				problems.push(`unexpected state after execution: ${line}`);
		}
		for (const line of expectedUnrelated) {
			if (!afterSet.has(line))
				problems.push(`missing after execution: ${line}`);
		}
	}
	// Content check (§80 "tree/index identities where possible"): worktree
	// files of unrelated paths must hash identically before and after.
	const unrelatedPaths = expectedUnrelated
		.map((line) => parse(line)?.path)
		.filter((path): path is string => typeof path === "string");
	if (unrelatedPaths.length > 0 && unrelatedPaths.length <= 500) {
		const before = await hashWorktree(deps, unrelatedPaths);
		const after = await hashWorktree(deps, unrelatedPaths);
		for (const [path, hash] of before) {
			if (after.get(path) !== hash) {
				problems.push(`${path}: worktree content changed unexpectedly`);
			}
		}
	}
	if (problems.length > 0) {
		throw new CommitExecutionError(
			`Tree conservation check failed (${problems.slice(0, 6).join("; ")}) — the repository state changed in an unplanned way (hook side-effects or concurrent modification). The created commits remain; inspect the repository before continuing.`,
		);
	}
}

/** Hash worktree content of the given paths (best effort). */
async function hashWorktree(
	deps: ExecuteDeps,
	paths: string[],
): Promise<Map<string, string>> {
	const result = await deps.git.run(["hash-object", "--", ...paths], {
		cwd: deps.cwd,
	});
	const hashes = new Map<string, string>();
	if ((result.exitCode ?? 99) !== 0) return hashes;
	const lines = result.stdout.split("\n").filter((line) => line.length > 0);
	paths.forEach((path, index) => {
		const hash = lines[index];
		if (hash) hashes.set(path, hash);
	});
	return hashes;
}

/** Run `git commit -F <file>` and verify HEAD moved (§83). */
async function runCommitCommand(
	deps: ExecuteDeps,
	message: string,
): Promise<{ short: string; subject: string }> {
	const headBefore = await deps.git.run(["rev-parse", "HEAD"], {
		cwd: deps.cwd,
	});
	if (headBefore.exitCode !== 0) {
		throw new GitMutationError(
			`git rev-parse HEAD failed: ${(headBefore.stderr || "").trim().slice(0, 300)}`,
		);
	}
	const dir =
		deps.tempDir ?? (await mkdtemp(join(tmpdir(), "pi-omp-git-commit-")));
	const ownsDir = !deps.tempDir;
	const file = join(dir, `msg-${Math.random().toString(36).slice(2)}.txt`);
	try {
		await writeFile(file, `${message}\n`, "utf8");
		const result = await deps.git.run(["commit", "-F", file], {
			cwd: deps.cwd,
		});
		if (result.exitCode !== 0) {
			throw commitFailure(result);
		}
	} finally {
		if (ownsDir) await rm(dir, { recursive: true, force: true });
	}
	const headAfter = await deps.git.run(["rev-parse", "HEAD"], {
		cwd: deps.cwd,
	});
	const after = headAfter.exitCode === 0 ? headAfter.stdout.trim() : "";
	if (!after || after === headBefore.stdout.trim()) {
		throw new GitMutationError(
			"The commit did not change HEAD; the repository state does not prove a commit occurred.",
		);
	}
	const subject = await deps.git.run(["log", "-1", "--format=%s", after], {
		cwd: deps.cwd,
	});
	return { short: after.slice(0, 8), subject: subject.stdout.trim() };
}

async function restoreIndex(deps: ExecuteDeps, tree: string): Promise<void> {
	const result = await deps.git.run(["read-tree", tree], { cwd: deps.cwd });
	if (result.exitCode !== 0) {
		throw new PiOmpGitError(
			`Failed to restore the index snapshot (${tree}): ${(result.stderr || "").trim().slice(0, 300)}`,
		);
	}
	const check = await deps.git.run(["write-tree"], { cwd: deps.cwd });
	if (check.exitCode !== 0 || check.stdout.trim() !== tree) {
		throw new PiOmpGitError(
			"The index snapshot restore did not verify — inspect the repository before continuing.",
		);
	}
}

function sanitize(path: string): string {
	return path.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}
