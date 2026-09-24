/**
 * AI Stage (docs/pi-omp-git-reference.md §70–§71).
 *
 * The user gives a natural-language instruction; a nested agent session
 * with read-only tools and a `propose_stage_plan` proposal tool produces
 * a staging plan of matching files and hunks. Nothing stages until the
 * caller confirms the plan. Application is safe by contract: the index
 * tree is snapshotted before, every intended hunk is verified staged and
 * every rejected hunk verified unstaged after, a halfway failure
 * restores the snapshot, and the working tree never loses content (all
 * operations are index-side).
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	type NestedModel,
	type NestedSessionFactory,
	runNestedAgent,
} from "../github/nested-agent.ts";
import { PiOmpGitError } from "../shared/errors.ts";
import { countHunkBodies, hunkBody } from "./diff.ts";
import {
	type OpsDeps,
	stageFileHunk,
	stageFileHunkUntracked,
	stageFilePath,
} from "./model-ops.ts";
import type { GitRunner } from "./runner.ts";
import {
	fetchFileDiff,
	type GitUiState,
	refreshGitState,
} from "./status-model.ts";

export interface AiStageDeps {
	git: GitRunner;
	cwd: string;
	model?: NestedModel;
	createNestedSession?: NestedSessionFactory;
	signal?: AbortSignal;
}

/** One planned file: whole file (hunks empty) or specific hunk indices. */
export interface StagePlanEntry {
	path: string;
	/** Empty array means the whole file (binary / indivisible changes). */
	hunks: number[];
}

export interface StagePlan {
	files: StagePlanEntry[];
}

/** The unstaged diff context captured for one file during planning. */
interface PlannedFileContext {
	path: string;
	untracked: boolean;
	binary: boolean;
	hunkBodies: string[];
	diffText: string;
}

const STAGE_PLAN_SCHEMA = Type.Object({
	files: Type.Array(
		Type.Object({
			path: Type.String(),
			hunks: Type.Array(Type.Integer()),
		}),
	),
});

type StagePlanParams = Static<typeof STAGE_PLAN_SCHEMA>;

/**
 * Produce a staging plan for a natural-language instruction (§70).
 * Read-only: nothing is staged here.
 */
export async function planAiStage(
	deps: AiStageDeps,
	state: GitUiState,
	instruction: string,
): Promise<StagePlan> {
	const trimmed = instruction.trim();
	if (!trimmed) {
		throw new PiOmpGitError(
			"Describe what to stage, e.g. 'stage the retry handling'.",
		);
	}
	if (state.unstaged.length === 0 && state.staged.length === 0) {
		throw new PiOmpGitError("There are no changes to stage.");
	}

	// Gather the unstaged diff context the agent plans over (read-only).
	const contexts: PlannedFileContext[] = [];
	for (const file of state.unstaged) {
		const diff = await fetchFileDiff(
			{ git: deps.git },
			state,
			"unstaged",
			file.path,
		);
		const hunks = diff.parsed?.hunks ?? [];
		contexts.push({
			path: file.path,
			untracked: file.state === "?",
			binary: !!file.binary,
			hunkBodies: hunks.map((hunk) =>
				hunk.lines
					.filter((line) => line.kind !== "context")
					.map((line) => `${line.kind === "add" ? "+" : "-"}${line.text}`)
					.join("\n"),
			),
			diffText: diff.text ?? "",
		});
	}
	if (contexts.length === 0) {
		throw new PiOmpGitError("There are no unstaged changes to plan over.");
	}

	const sections: string[] = [
		"Plan which unstaged changes to stage for this instruction:",
		"",
		trimmed,
		"",
		"Unstaged changes:",
	];
	for (const [index, context] of contexts.entries()) {
		const kind = context.binary
			? "binary (file-level only)"
			: context.untracked
				? "untracked file"
				: "tracked file";
		sections.push(`\n[${index}] ${context.path} — ${kind}`);
		context.hunkBodies.forEach((body, hunkIndex) => {
			const preview = body.length > 400 ? `${body.slice(0, 400)}…` : body;
			sections.push(`hunk ${hunkIndex}:\n${preview}`);
		});
		if (context.binary) sections.push("(binary content not shown)");
	}
	sections.push(
		"",
		"Call the propose_stage_plan tool with the files and hunks to stage.",
		"Rules: hunk indices refer to the listings above; use an empty hunk",
		"list to stage a whole file (required for binary files); leave",
		"unrelated changes out entirely. Never propose paths that are not",
		"listed. Never commit.",
	);

	const recorded: StagePlanParams[] = [];
	const proposeTool: ToolDefinition<typeof STAGE_PLAN_SCHEMA> = {
		name: "propose_stage_plan",
		label: "Propose stage plan",
		description:
			"Propose the files and hunks to stage. Empty hunks array stages the whole file.",
		parameters: STAGE_PLAN_SCHEMA,
		execute: async (_toolCallId, params) => {
			recorded.push(params);
			return {
				content: [{ type: "text", text: "Stage plan recorded." }],
				details: undefined,
			};
		},
	};

	const run = await runNestedAgent({
		cwd: deps.cwd,
		prompt: sections.join("\n"),
		tools: ["read", "grep", "find", "ls"],
		customTools: [proposeTool],
		model: deps.model,
		signal: deps.signal,
		createSession: deps.createNestedSession,
	});
	void run;

	const proposal = recorded.at(-1);
	if (!proposal) {
		throw new PiOmpGitError("The nested agent did not propose a staging plan.");
	}
	return validateStagePlan(proposal, contexts);
}

/** Validate the proposal against the captured context (deterministic). */
export function validateStagePlan(
	proposal: StagePlanParams,
	contexts: PlannedFileContext[],
): StagePlan {
	const byPath = new Map(contexts.map((context) => [context.path, context]));
	const files: StagePlanEntry[] = [];
	for (const entry of proposal.files) {
		const context = byPath.get(entry.path);
		if (!context) {
			throw new PiOmpGitError(
				`The staging plan references unknown path ${entry.path}.`,
			);
		}
		const unique = [...new Set(entry.hunks)].sort((a, b) => a - b);
		if (context.binary) {
			if (unique.length > 0) {
				throw new PiOmpGitError(
					`${entry.path} is binary — the plan must stage it at file level.`,
				);
			}
			files.push({ path: entry.path, hunks: [] });
			continue;
		}
		for (const hunk of unique) {
			if (
				!Number.isInteger(hunk) ||
				hunk < 0 ||
				hunk >= context.hunkBodies.length
			) {
				throw new PiOmpGitError(
					`The staging plan references hunk ${hunk} of ${entry.path}, which does not exist.`,
				);
			}
		}
		files.push({ path: entry.path, hunks: unique });
	}
	return { files };
}

export interface AiStageApplyOptions {
	/** Confirmation gate: the plan is applied only after the user confirms. */
	confirmed: boolean;
}

export interface AiStageOutcome {
	stagedFiles: string[];
	stagedHunks: number;
	restored: boolean;
}

/** Per-file facts captured before any mutation (§71 verification). */
interface FileBaseline {
	path: string;
	/** Unstaged diff text before the operation. */
	unstagedText: string;
	/** Normalized changed-line bodies, one per hunk of the unstaged diff. */
	bodies: string[];
	/** Staged diff text before the operation. */
	stagedText: string;
}

/**
 * Apply a confirmed plan (§71): snapshot the index tree, stage the
 * planned files/hunks (hunks in descending index order so earlier
 * indices stay valid), then verify. On any failure the index snapshot is
 * restored and the error rethrown — a partial application is never
 * reported as success. The working tree is never modified: every
 * operation here is index-side.
 */
export async function applyAiStage(
	deps: AiStageDeps,
	state: GitUiState,
	plan: StagePlan,
	options: AiStageApplyOptions,
): Promise<AiStageOutcome> {
	if (!options.confirmed) {
		throw new PiOmpGitError(
			"The staging plan must be confirmed before anything is staged.",
		);
	}
	const ops: OpsDeps = { git: deps.git, root: state.root };
	const baselines = await captureBaselines(deps, state);
	const snapshot = await snapshotIndex(deps);
	const stagedFiles: string[] = [];
	try {
		for (const entry of plan.files) {
			const file = state.unstaged.find(
				(candidate) => candidate.path === entry.path,
			);
			if (!file) {
				throw new PiOmpGitError(
					`${entry.path} is no longer unstaged — the plan is stale.`,
				);
			}
			if (entry.hunks.length === 0) {
				await stageFilePath(ops, state, entry.path);
			} else {
				// Descending order: staging hunk k removes it from the
				// unstaged diff, shifting later hunks' indices down.
				for (const hunk of [...entry.hunks].sort((a, b) => b - a)) {
					if (file.state === "?") {
						await stageFileHunkUntracked(ops, entry.path, hunk);
					} else {
						await stageFileHunk(ops, state, entry.path, hunk);
					}
				}
			}
			stagedFiles.push(entry.path);
		}
	} catch (error) {
		await restoreIndex(deps, snapshot);
		throw error;
	}

	// §71 verification against freshly collected state: intended hunks
	// staged, rejected hunks unstaged, unrelated files untouched.
	const afterState = await refreshGitState({ git: deps.git }, deps.cwd);
	const verification = await verifyApplied(
		deps,
		state,
		afterState,
		baselines,
		plan,
	);
	if (!verification.ok) {
		await restoreIndex(deps, snapshot);
		throw new PiOmpGitError(
			`AI staging verification failed: ${verification.reason}. The index was restored to its previous state.`,
		);
	}
	return {
		stagedFiles,
		stagedHunks: plan.files.reduce((sum, entry) => sum + entry.hunks.length, 0),
		restored: false,
	};
}

/** Snapshot the index tree (§71). Fails on unmerged index entries. */
export async function snapshotIndex(deps: AiStageDeps): Promise<string> {
	const result = await deps.git.run(["write-tree"], { cwd: deps.cwd });
	if (result.exitCode !== 0) {
		throw new PiOmpGitError(
			`Cannot snapshot the index for AI staging${/unmerged|conflict/i.test(result.stderr) ? " (the index has unmerged entries — resolve conflicts first)" : ""}: ${(result.stderr || "").trim().slice(0, 300)}`,
		);
	}
	return result.stdout.trim();
}

/** Restore the index snapshot; the working tree is untouched. */
export async function restoreIndex(
	deps: AiStageDeps,
	tree: string,
): Promise<void> {
	const result = await deps.git.run(["read-tree", tree], { cwd: deps.cwd });
	if (result.exitCode !== 0) {
		throw new PiOmpGitError(
			`Failed to restore the index snapshot (${tree}): ${(result.stderr || "").trim().slice(0, 300)}`,
		);
	}
	// Prove the restore: the index tree must equal the snapshot again.
	const check = await deps.git.run(["write-tree"], { cwd: deps.cwd });
	if (check.exitCode !== 0 || check.stdout.trim() !== tree) {
		throw new PiOmpGitError(
			"The index snapshot restore did not verify — inspect the repository before continuing.",
		);
	}
}

interface Verification {
	ok: boolean;
	reason?: string;
}

/** Capture per-file before-state for the §71 verification. */
async function captureBaselines(
	deps: AiStageDeps,
	state: GitUiState,
): Promise<Map<string, FileBaseline>> {
	const baselines = new Map<string, FileBaseline>();
	for (const file of state.unstaged) {
		const unstaged = await fetchFileDiff(
			{ git: deps.git },
			state,
			"unstaged",
			file.path,
		);
		const staged =
			file.state === "?"
				? { text: undefined }
				: await fetchFileDiff({ git: deps.git }, state, "staged", file.path);
		baselines.set(file.path, {
			path: file.path,
			unstagedText: unstaged.text ?? "",
			bodies: (unstaged.parsed?.hunks ?? []).map((_hunk, index) =>
				hunkBody(unstaged.text ?? "", index),
			),
			stagedText: staged.text ?? "",
		});
	}
	return baselines;
}

/**
 * Verify intended hunks staged, rejected hunks unstaged, and unrelated
 * files untouched — comparing freshly collected Git state against the
 * pre-operation baselines.
 */
async function verifyApplied(
	deps: AiStageDeps,
	beforeState: GitUiState,
	afterState: GitUiState,
	baselines: Map<string, FileBaseline>,
	plan: StagePlan,
): Promise<Verification> {
	const plannedPaths = new Set(plan.files.map((entry) => entry.path));

	for (const entry of plan.files) {
		const baseline = baselines.get(entry.path);
		if (!baseline) {
			return {
				ok: false,
				reason: `${entry.path} was not captured before staging`,
			};
		}
		const stillUnstaged = afterState.unstaged.find(
			(candidate) => candidate.path === entry.path,
		);
		const unstagedAfter = await diffText(
			deps,
			afterState,
			"unstaged",
			entry.path,
		);
		const stagedAfter = await diffText(deps, afterState, "staged", entry.path);

		if (entry.hunks.length === 0) {
			// Whole file: nothing of it may remain unstaged and it must
			// be represented in the index.
			if (unstagedAfter.trim() !== "") {
				return {
					ok: false,
					reason: `${entry.path} still has unstaged changes`,
				};
			}
			if (stagedAfter.trim() === "") {
				return {
					ok: false,
					reason: `${entry.path} has no staged representation`,
				};
			}
			continue;
		}
		const rejectedIndices = baseline.bodies
			.map((_body, index) => index)
			.filter((index) => !entry.hunks.includes(index));
		if (!stillUnstaged) {
			// The file left the unstaged set: legitimate only when every
			// hunk was planned — then each must be represented staged.
			if (rejectedIndices.length > 0) {
				return {
					ok: false,
					reason: `${entry.path} left the unstaged set with unplanned hunks`,
				};
			}
			for (const [hunkIndex, body] of baseline.bodies.entries()) {
				const stagedBefore = countHunkBodies(baseline.stagedText, body);
				const stagedNow = countHunkBodies(stagedAfter, body);
				if (stagedNow <= stagedBefore) {
					return {
						ok: false,
						reason: `hunk ${hunkIndex + 1} of ${entry.path} is not represented in the staged diff`,
					};
				}
				void hunkIndex;
			}
			continue;
		}
		for (const [hunkIndex, body] of baseline.bodies.entries()) {
			const before = countHunkBodies(baseline.unstagedText, body);
			const after = countHunkBodies(unstagedAfter, body);
			if (entry.hunks.includes(hunkIndex)) {
				// Intended: exactly one occurrence moved to the index.
				if (after !== before - 1) {
					return {
						ok: false,
						reason: `hunk ${hunkIndex + 1} of ${entry.path} was not staged exactly once`,
					};
				}
				const stagedBefore = countHunkBodies(baseline.stagedText, body);
				const stagedNow = countHunkBodies(stagedAfter, body);
				if (stagedNow <= stagedBefore) {
					return {
						ok: false,
						reason: `hunk ${hunkIndex + 1} of ${entry.path} is not represented in the staged diff`,
					};
				}
			} else {
				// Rejected: must remain unstaged, unchanged.
				if (after !== before) {
					return {
						ok: false,
						reason: `hunk ${hunkIndex + 1} of ${entry.path} changed without being planned`,
					};
				}
			}
		}
	}

	// Unrelated files: their unstaged diffs must be byte-identical.
	for (const file of beforeState.unstaged) {
		if (plannedPaths.has(file.path)) continue;
		const after = await diffText(deps, afterState, "unstaged", file.path);
		const baseline = baselines.get(file.path);
		if (!baseline || after !== baseline.unstagedText) {
			return { ok: false, reason: `${file.path} changed as a side effect` };
		}
	}
	return { ok: true };
}

/** The current diff text for one side of a path ("" when absent). */
async function diffText(
	deps: AiStageDeps,
	state: GitUiState,
	side: "staged" | "unstaged",
	path: string,
): Promise<string> {
	try {
		const diff = await fetchFileDiff({ git: deps.git }, state, side, path);
		return diff.text ?? "";
	} catch {
		return "";
	}
}
