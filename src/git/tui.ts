/**
 * `/git` TUI: controller plus component (docs/pi-omp-git-reference.md
 * §60–§61, §64–§67, §72, tickets 17–19).
 *
 * The controller owns selection state and dispatches model operations,
 * refreshing from Git after every mutation. It is fully headless — the
 * component is a thin renderer over controller state and can be
 * exercised without a terminal by calling render()/handleInput()
 * directly.
 */

import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import {
	type AiStageDeps,
	applyAiStage,
	planAiStage,
	type StagePlan,
} from "./ai-stage.ts";
import {
	type CommitOpsDeps,
	executeCommit,
	generateCommitMessage,
} from "./commit-ops.ts";
import {
	discardAllWarning,
	discardFileHunk,
	discardStagedFile,
	discardUnstagedFile,
	type OpsDeps,
	stageFileHunk,
	stageFileHunkUntracked,
	stageFilePath,
	unstageFileHunk,
	unstageFilePath,
} from "./model-ops.ts";
import {
	collectRevisionStatus,
	fetchRevisionFileDiff,
	type RevisionUiState,
} from "./revision.ts";
import type { GitRunner } from "./runner.ts";
import {
	type FileDiff,
	fetchFileDiff,
	type GitSelection,
	type GitUiState,
	refreshGitState,
} from "./status-model.ts";

export type Area = "staged" | "unstaged" | "conflicts";

interface FileRow {
	area: Area;
	path: string;
	label: string;
}

/** Minimal single-cursor text buffer shared by the composer and prompts. */
interface TextBuffer {
	text: string;
	cursor: number;
}

function bufferInsert(buffer: TextBuffer, text: string): void {
	buffer.text =
		buffer.text.slice(0, buffer.cursor) +
		text +
		buffer.text.slice(buffer.cursor);
	buffer.cursor += text.length;
}

function bufferBackspace(buffer: TextBuffer): void {
	if (buffer.cursor === 0) return;
	buffer.text =
		buffer.text.slice(0, buffer.cursor - 1) + buffer.text.slice(buffer.cursor);
	buffer.cursor -= 1;
}

function bufferMove(buffer: TextBuffer, delta: -1 | 1): void {
	buffer.cursor = Math.min(
		buffer.text.length,
		Math.max(0, buffer.cursor + delta),
	);
}

function bufferMoveLine(buffer: TextBuffer, delta: -1 | 1): void {
	const lineStarts = [0];
	for (let index = 0; index < buffer.text.length; index += 1) {
		if (buffer.text[index] === "\n") lineStarts.push(index + 1);
	}
	const currentLine =
		lineStarts.filter((start) => start <= buffer.cursor).length - 1;
	const target = currentLine + delta;
	if (target < 0 || target >= lineStarts.length) return;
	buffer.cursor = lineStarts[target] ?? 0;
}

/**
 * Headless controller: selection state, diff loading, and mutation
 * dispatch with refresh-after-mutation (§62: state is re-read from Git
 * after every mutation, never inferred from exit text).
 */
export class GitTuiController {
	state: GitUiState;
	rows: FileRow[] = [];
	selectedRow = 0;
	/** Hunk mode: operations apply to the selected hunk. */
	hunkMode = false;
	selectedHunk = 0;
	diff: FileDiff | null = null;
	message: string | null = null;
	/** Pending destructive action awaiting explicit confirmation (§64). */
	pendingConfirm: {
		area: "staged" | "unstaged";
		path: string;
		hunk?: number;
		prompt: string;
	} | null = null;
	/** Commit composer state (§72); non-null while composing. */
	composer: {
		text: string;
		cursor: number;
		amend: boolean;
		generating: boolean;
	} | null = null;
	/** AI Stage instruction prompt (§70); non-null while typing. */
	aiPrompt: (TextBuffer & { planning: boolean }) | null = null;
	/** A produced staging plan awaiting explicit confirmation. */
	pendingAiPlan: { plan: StagePlan; instruction: string } | null = null;
	/** Revision mode state (§67); non-null turns the UI read-only. */
	revisionState: RevisionUiState | null;
	private diffSide: "staged" | "unstaged" = "unstaged";
	private diffPath: string | null = null;

	constructor(
		private options: {
			git: GitRunner;
			cwd: string;
			onChange?: () => void;
			/** Parent session model for AI message generation (§72). */
			model?: CommitOpsDeps["model"];
			createNestedSession?: CommitOpsDeps["createNestedSession"];
		},
		initialState: GitUiState,
		revisionState?: RevisionUiState | null,
	) {
		this.state = initialState;
		this.revisionState = revisionState ?? null;
		this.rebuildRows();
	}

	isRevisionMode(): boolean {
		return this.revisionState !== null;
	}

	private commitOps(): CommitOpsDeps {
		return {
			git: this.options.git,
			cwd: this.options.cwd,
			model: this.options.model,
			createNestedSession: this.options.createNestedSession,
		};
	}

	private aiStageDeps(): AiStageDeps {
		return {
			git: this.options.git,
			cwd: this.options.cwd,
			model: this.options.model,
			createNestedSession: this.options.createNestedSession,
		};
	}

	private ops(): OpsDeps {
		return { git: this.options.git, root: this.state.root };
	}

	/** Observe settled mutations (the TUI requests a render). */
	setOnChange(onChange: () => void): void {
		this.options.onChange = onChange;
	}

	private rebuildRows(): void {
		const rows: FileRow[] = [];
		if (this.revisionState) {
			for (const file of this.revisionState.files) {
				rows.push({
					area: "unstaged",
					path: file.path,
					label: `${file.state} ${file.path}${file.binary ? " [binary]" : file.lfs ? " [LFS]" : ""}`,
				});
			}
			this.rows = rows;
			if (this.selectedRow >= rows.length) {
				this.selectedRow = Math.max(0, rows.length - 1);
			}
			return;
		}
		const label = (
			state: string,
			path: string,
			origPath?: string,
			flags = "",
		): string => `${state} ${path}${origPath ? ` <- ${origPath}` : ""}${flags}`;
		const flags = (file: { binary?: boolean; lfs?: boolean }): string =>
			file.binary ? " [binary]" : file.lfs ? " [LFS]" : "";
		for (const file of this.state.staged) {
			rows.push({
				area: "staged",
				path: file.path,
				label: label(file.state, file.path, file.origPath, flags(file)),
			});
		}
		for (const file of this.state.unstaged) {
			rows.push({
				area: "unstaged",
				path: file.path,
				label: label(file.state, file.path, file.origPath, flags(file)),
			});
		}
		for (const file of this.state.conflicts) {
			rows.push({
				area: "conflicts",
				path: file.path,
				label: `U ${file.path} [conflict]`,
			});
		}
		this.rows = rows;
		if (this.selectedRow >= rows.length) {
			this.selectedRow = Math.max(0, rows.length - 1);
		}
	}

	/** Re-read the full state model from Git (§62). */
	async refresh(): Promise<void> {
		if (this.revisionState) {
			this.revisionState = await collectRevisionStatus(
				{ git: this.options.git },
				this.options.cwd,
				this.revisionState.revision,
			);
			this.rebuildRows();
			this.diffPath = null;
			await this.loadDiff();
			return;
		}
		const selection = this.currentSelection();
		this.state = await refreshGitState(
			{ git: this.options.git },
			this.options.cwd,
			selection ?? undefined,
		);
		this.rebuildRows();
		// Reload the diff for the (possibly moved) selection.
		this.diffPath = null;
		await this.loadDiff();
	}

	currentSelection(): GitSelection | null {
		const row = this.rows[this.selectedRow];
		if (!row) return null;
		return {
			area: row.area,
			file: row.path,
			hunk: this.hunkMode ? this.selectedHunk : undefined,
		};
	}

	currentArea(): Area | null {
		return this.rows[this.selectedRow]?.area ?? null;
	}

	currentPath(): string | null {
		return this.rows[this.selectedRow]?.path ?? null;
	}

	select(delta: number): void {
		const previousArea = this.currentArea();
		if (this.rows.length === 0) {
			this.selectedRow = 0;
			return;
		}
		this.selectedRow = Math.min(
			this.rows.length - 1,
			Math.max(0, this.selectedRow + delta),
		);
		this.hunkMode = false;
		this.selectedHunk = 0;
		const area = this.currentArea();
		if (area !== previousArea) {
			// Keep the diff side aligned when the area changes.
			if (area === "unstaged") this.diffSide = "unstaged";
			if (area === "staged") this.diffSide = "staged";
		}
		this.diffPath = null;
	}

	switchArea(): void {
		if (this.revisionState) return;
		const order: Area[] = ["unstaged", "staged", "conflicts"];
		const current = this.currentArea() ?? "unstaged";
		const target = order[(order.indexOf(current) + 1) % order.length];
		const rowIndex = this.rows.findIndex((row) => row.area === target);
		if (rowIndex >= 0) {
			this.selectedRow = rowIndex;
			this.hunkMode = false;
			this.selectedHunk = 0;
			this.diffSide = target === "staged" ? "staged" : "unstaged";
			this.diffPath = null;
		}
	}

	enterHunkMode(): boolean {
		const hunks = this.diff?.parsed?.hunks;
		if (!hunks || hunks.length === 0) return false;
		this.hunkMode = true;
		this.selectedHunk = Math.min(this.selectedHunk, hunks.length - 1);
		return true;
	}

	exitHunkMode(): void {
		this.hunkMode = false;
	}

	moveHunk(delta: number): void {
		const count = this.diff?.parsed?.hunks.length ?? 0;
		if (count === 0) return;
		this.selectedHunk = Math.min(
			count - 1,
			Math.max(0, this.selectedHunk + delta),
		);
	}

	/** Load (or reuse) the diff for the current selection. */
	async loadDiff(): Promise<void> {
		const path = this.currentPath();
		const area = this.currentArea();
		if (!path || !area || area === "conflicts") {
			this.diff = null;
			return;
		}
		if (this.revisionState) {
			if (this.diffPath === path && this.diff) return;
			try {
				this.diff = await fetchRevisionFileDiff(
					{ git: this.options.git },
					this.revisionState,
					path,
				);
				this.diffPath = path;
			} catch (error) {
				this.message = error instanceof Error ? error.message : String(error);
				this.diff = null;
			}
			return;
		}
		const side: "staged" | "unstaged" =
			area === "staged" ? "staged" : this.diffSide;
		if (this.diffPath === path && this.diffSide === side && this.diff) return;
		try {
			this.diff = await fetchFileDiff(
				{ git: this.options.git },
				this.state,
				side,
				path,
			);
			this.diffPath = path;
			this.diffSide = side;
		} catch (error) {
			this.message = error instanceof Error ? error.message : String(error);
			this.diff = null;
		}
	}

	hasPendingConfirm(): boolean {
		return this.pendingConfirm !== null;
	}

	confirmPending(): void {
		const pending = this.pendingConfirm;
		this.pendingConfirm = null;
		if (!pending) return;
		void this.run(async () => {
			if (pending.hunk === undefined) {
				if (pending.area === "staged") {
					await discardStagedFile(this.ops(), this.state, pending.path);
				} else {
					await discardUnstagedFile(this.ops(), this.state, pending.path);
				}
			} else {
				await discardFileHunk(
					this.ops(),
					this.state,
					pending.path,
					pending.hunk,
				);
			}
		});
	}

	cancelPending(): void {
		this.pendingConfirm = null;
		this.message = null;
	}

	/** Perform the action for the current selection (file or hunk mode). */
	primary(stage: "stage" | "unstage" | "discard"): void {
		const path = this.currentPath();
		const area = this.currentArea();
		if (!path || !area) return;
		if (this.revisionState) {
			this.message =
				"Revision mode is read-only — working-tree mutations are disabled.";
			return;
		}
		if (area === "conflicts") {
			this.message =
				"Conflicted files cannot be staged or discarded here — resolve the conflict first.";
			return;
		}
		const hunk = this.hunkMode ? this.selectedHunk : undefined;
		if (stage === "discard") {
			const prompt =
				hunk !== undefined
					? `Discard hunk ${hunk + 1} of ${path}? This cannot be undone.`
					: (discardAllWarning(this.state, path) ??
						(this.state.unstaged.some(
							(entry) => entry.path === path && entry.state === "?",
						)
							? `Delete untracked file ${path}? This cannot be undone.`
							: `Discard all changes in ${path}? This cannot be undone.`));
			this.pendingConfirm = {
				area,
				path,
				...(hunk !== undefined ? { hunk } : {}),
				prompt,
			};
			this.message = `${prompt} Press y to confirm, n to cancel.`;
			return;
		}
		if (hunk === undefined) {
			if (stage === "stage") {
				void this.run(async () => stageFilePath(this.ops(), this.state, path));
			} else {
				void this.run(async () =>
					unstageFilePath(this.ops(), this.state, path),
				);
			}
			return;
		}
		if (stage === "stage") {
			if (area === "staged") {
				this.message =
					"This hunk is already staged — switch to the unstaged side to stage more.";
				return;
			}
			const isUntracked = this.state.unstaged.some(
				(entry) => entry.path === path && entry.state === "?",
			);
			void this.run(async () => {
				if (isUntracked) {
					await stageFileHunkUntracked(this.ops(), path, hunk);
				} else {
					await stageFileHunk(this.ops(), this.state, path, hunk);
				}
			});
		} else {
			if (area === "unstaged") {
				this.message =
					"Nothing staged for this hunk — switch to the staged side to unstage.";
				return;
			}
			void this.run(async () =>
				unstageFileHunk(this.ops(), this.state, path, hunk),
			);
		}
	}

	/** Run an action, then refresh state from Git and reload the diff. */
	private async run<T>(
		action: () => Promise<T>,
		after?: (result: T) => string | null,
	): Promise<void> {
		try {
			const result = await action();
			this.message = after ? after(result) : null;
			await this.refresh();
		} catch (error) {
			this.message = error instanceof Error ? error.message : String(error);
			// Refresh even after failure: the repository may have changed.
			try {
				await this.refresh();
			} catch {
				// keep the failure message
			}
		} finally {
			this.options.onChange?.();
		}
	}

	refreshNow(): void {
		void this.run(async () => {});
	}

	// ── Commit composer (§72) ─────────────────────────────────────────

	/**
	 * Open the composer. With nothing staged it opens anyway so amend
	 * stays reachable; committing an empty staged set surfaces git's own
	 * "nothing to commit" error honestly.
	 */
	openComposer(): void {
		if (this.revisionState) {
			this.message = "Revision mode is read-only — committing is disabled.";
			return;
		}
		if (this.composer) return;
		this.composer = { text: "", cursor: 0, amend: false, generating: false };
		this.message =
			this.state.staged.length === 0
				? "Nothing staged — press a for amend, or Escape to cancel."
				: null;
	}

	closeComposer(): void {
		this.composer = null;
		this.message = null;
	}

	toggleAmend(): void {
		if (!this.composer) return;
		this.composer.amend = !this.composer.amend;
	}

	/** AI-generated Conventional Commits message, editable afterwards (§72). */
	generateMessage(): void {
		const composer = this.composer;
		if (!composer || composer.generating) return;
		composer.generating = true;
		void this.run(
			async () => {
				const message = await generateCommitMessage(this.commitOps(), {
					amend: composer.amend,
				});
				composer.text = message;
				composer.cursor = message.length;
			},
			() => "Generated commit message — edit it, then press Enter.",
		).finally(() => {
			composer.generating = false;
		});
	}

	/** Execute the composed commit; success is proven by HEAD movement. */
	commitNow(): void {
		const composer = this.composer;
		if (!composer) return;
		void this.run(
			async () => {
				const outcome = await executeCommit(this.commitOps(), {
					message: composer.text,
					amend: composer.amend,
				});
				this.composer = null;
				return outcome;
			},
			(outcome) =>
				outcome
					? `${outcome.amend ? "Amended" : "Committed"} ${outcome.short}.`
					: null,
		);
	}

	// Minimal editable buffer for the composer (§72: user can edit the
	// generated text before execution).

	composerInsert(text: string): void {
		if (!this.composer) return;
		const { text: current, cursor } = this.composer;
		this.composer.text =
			current.slice(0, cursor) + text + current.slice(cursor);
		this.composer.cursor = cursor + text.length;
	}

	composerBackspace(): void {
		if (!this.composer || this.composer.cursor === 0) return;
		const { text, cursor } = this.composer;
		this.composer.text = text.slice(0, cursor - 1) + text.slice(cursor);
		this.composer.cursor = cursor - 1;
	}

	composerMove(delta: -1 | 1): void {
		if (!this.composer) return;
		this.composer.cursor = Math.min(
			this.composer.text.length,
			Math.max(0, this.composer.cursor + delta),
		);
	}

	composerMoveLine(delta: -1 | 1): void {
		if (!this.composer) return;
		const { text, cursor } = this.composer;
		const lineStarts = [0];
		for (let index = 0; index < text.length; index += 1) {
			if (text[index] === "\n") lineStarts.push(index + 1);
		}
		const currentLine =
			lineStarts.filter((start) => start <= cursor).length - 1;
		const target = currentLine + delta;
		if (target < 0 || target >= lineStarts.length) return;
		this.composer.cursor = lineStarts[target] ?? 0;
	}

	// ── AI Stage (§70) ────────────────────────────────────────────────

	/** Open the natural-language staging prompt. */
	openAiPrompt(): void {
		if (this.revisionState) {
			this.message = "Revision mode is read-only — AI staging is disabled.";
			return;
		}
		if (this.aiPrompt || this.pendingAiPlan) return;
		if (this.state.unstaged.length === 0) {
			this.message = "There are no unstaged changes for AI staging.";
			return;
		}
		this.aiPrompt = { text: "", cursor: 0, planning: false };
		this.message = null;
	}

	closeAiPrompt(): void {
		this.aiPrompt = null;
		this.pendingAiPlan = null;
		this.message = null;
	}

	aiInsert(text: string): void {
		if (this.aiPrompt) bufferInsert(this.aiPrompt, text);
	}

	aiBackspace(): void {
		if (this.aiPrompt) bufferBackspace(this.aiPrompt);
	}

	aiMove(delta: -1 | 1): void {
		if (this.aiPrompt) bufferMove(this.aiPrompt, delta);
	}

	aiMoveLine(delta: -1 | 1): void {
		if (this.aiPrompt) bufferMoveLine(this.aiPrompt, delta);
	}

	/** Ask the nested agent for a staging plan (read-only until confirmed). */
	planAiStageNow(): void {
		const prompt = this.aiPrompt;
		if (!prompt || prompt.planning) return;
		const instruction = prompt.text;
		if (!instruction.trim()) {
			this.message = "Describe what to stage first.";
			return;
		}
		prompt.planning = true;
		void this.run(
			async () => {
				const plan = await planAiStage(
					this.aiStageDeps(),
					this.state,
					instruction,
				);
				this.pendingAiPlan = { plan, instruction };
				this.aiPrompt = null;
				return plan;
			},
			(plan) =>
				plan
					? `Staging plan ready: ${plan.files.length} file(s) — press y to apply, n to cancel.`
					: null,
		).finally(() => {
			prompt.planning = false;
		});
	}

	/** Apply the confirmed plan (§71 safety contract). */
	confirmAiPlan(): void {
		const pending = this.pendingAiPlan;
		if (!pending) return;
		void this.run(
			async () => {
				const outcome = await applyAiStage(
					this.aiStageDeps(),
					this.state,
					pending.plan,
					{ confirmed: true },
				);
				this.pendingAiPlan = null;
				return outcome;
			},
			(outcome) =>
				outcome
					? `Staged ${outcome.stagedHunks} hunk(s) across ${outcome.stagedFiles.length} file(s).`
					: null,
		);
	}

	cancelAiPlan(): void {
		this.pendingAiPlan = null;
		this.message = null;
	}
}

function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	return text.length <= width
		? text
		: `${text.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Render the §61 layout: header, file sidebar, split old/new diff pane,
 * action/status bar. Pure function over controller state — no terminal
 * required.
 */
export function renderGitTui(
	controller: GitTuiController,
	width: number,
	height: number,
): string[] {
	const state = controller.state;
	const revision = controller.revisionState;
	const repoName = state.root.split("/").filter(Boolean).pop() ?? state.root;
	const headShort = state.head ? state.head.slice(0, 8) : "—";
	const lines: string[] = [];

	// Header: repository / branch / HEAD, or the inspected revision (§67).
	if (revision) {
		lines.push(
			truncate(
				`${repoName} — revision ${revision.revision.ref} @ ${revision.revision.commit.slice(0, 8)} — ${revision.revision.subject} (read-only)`,
				width,
			),
		);
	} else {
		lines.push(
			truncate(
				`${repoName} — ${state.branch ?? "(detached)"} @ ${headShort}`,
				width,
			),
		);
	}
	lines.push("─".repeat(Math.max(0, width)));

	// Sidebar rows with section headers.
	const sidebarWidth = Math.max(16, Math.min(40, Math.floor(width / 3)));
	const diffWidth = Math.max(20, width - sidebarWidth - 1);

	const sidebar: string[] = [];
	const sections: Array<{ title: string; area: Area }> = revision
		? [{ title: `Changes in ${revision.revision.ref}`, area: "unstaged" }]
		: [
				{ title: "Staged", area: "staged" },
				{ title: "Unstaged", area: "unstaged" },
				{ title: "Conflicts", area: "conflicts" },
			];
	for (const section of sections) {
		const entries = controller.rows.filter((row) => row.area === section.area);
		sidebar.push(`${section.title} (${entries.length})`);
		for (const row of entries) {
			const marker =
				controller.rows.indexOf(row) === controller.selectedRow ? ">" : " ";
			sidebar.push(`${marker} ${row.label}`);
		}
		sidebar.push("");
	}

	// Diff pane: old/new split.
	const diffLines: string[] = [];
	const path = controller.currentPath();
	if (!path) {
		diffLines.push("(no file selected)");
	} else if (controller.diff === null) {
		diffLines.push(controller.message ?? "(no diff)");
	} else if (controller.diff.oversized) {
		diffLines.push("File too large for interactive content preview.");
	} else if (controller.diff.binary) {
		diffLines.push("Binary file differs.");
	} else if (controller.diff.empty) {
		diffLines.push("(no diff)");
	} else if (controller.diff.parsed) {
		const colWidth = Math.max(8, Math.floor((diffWidth - 3) / 2));
		diffLines.push(`${"old".padEnd(colWidth)} | ${"new"}`);
		diffLines.push("─".repeat(Math.max(0, diffWidth)));
		for (const [hunkIndex, hunk] of controller.diff.parsed.hunks.entries()) {
			const selected =
				controller.hunkMode && controller.selectedHunk === hunkIndex;
			diffLines.push(
				`${selected ? ">" : " "} ${truncate(hunk.header, diffWidth - 2)}`,
			);
			// Side-by-side pairing: del/add blocks run in lockstep.
			let index = 0;
			const body = hunk.lines;
			while (index < body.length) {
				const dels: string[] = [];
				const adds: string[] = [];
				while (index < body.length && body[index]?.kind === "del") {
					dels.push(`-${body[index]?.text ?? ""}`);
					index += 1;
				}
				while (index < body.length && body[index]?.kind === "add") {
					adds.push(`+${body[index]?.text ?? ""}`);
					index += 1;
				}
				if (dels.length > 0 || adds.length > 0) {
					const rows = Math.max(dels.length, adds.length);
					for (let row = 0; row < rows; row += 1) {
						const oldSide = dels[row] ?? "";
						const newSide = adds[row] ?? "";
						diffLines.push(
							`${truncate(oldSide.padEnd(colWidth), colWidth)} | ${truncate(newSide, colWidth)}`,
						);
					}
					continue;
				}
				const contextLine = body[index];
				if (contextLine) {
					const text = ` ${contextLine.text}`;
					diffLines.push(
						`${truncate(text.padEnd(colWidth), colWidth)} | ${truncate(text, colWidth)}`,
					);
					index += 1;
				}
			}
		}
	}

	// Merge sidebar and diff panes row by row.
	const paneRows = Math.max(sidebar.length, diffLines.length);
	for (let row = 0; row < paneRows; row += 1) {
		const left = truncate(
			(sidebar[row] ?? "").padEnd(sidebarWidth),
			sidebarWidth,
		);
		const right = truncate(diffLines[row] ?? "", diffWidth);
		lines.push(`${left}│${right}`);
	}

	// AI staging prompt / plan panels (§70).
	if (controller.aiPrompt) {
		lines.push("─".repeat(Math.max(0, width)));
		const prompt = controller.aiPrompt;
		lines.push(
			truncate(
				prompt.planning
					? "AI staging — planning…"
					: "AI staging — describe what to stage [Enter] plan [Esc] cancel:",
				width,
			),
		);
		const cursorLine = prompt.text.slice(0, prompt.cursor);
		const lineIndex = cursorLine.split("\n").length - 1;
		const textLines = prompt.text.split("\n");
		for (const [index, textLine] of textLines.entries()) {
			const display =
				index === lineIndex
					? `${textLine.slice(0, prompt.cursor - cursorLine.lastIndexOf("\n") - 1)}▮${textLine.slice(Math.max(0, prompt.cursor - cursorLine.lastIndexOf("\n") - 1))}`
					: textLine;
			void index;
			lines.push(truncate(display, width));
		}
	}
	if (controller.pendingAiPlan) {
		lines.push("─".repeat(Math.max(0, width)));
		lines.push(
			truncate(
				`AI staging plan (${controller.pendingAiPlan.plan.files.length} file(s)) — [y] apply [n] cancel:`,
				width,
			),
		);
		for (const entry of controller.pendingAiPlan.plan.files) {
			const detail =
				entry.hunks.length === 0
					? "whole file"
					: `hunks ${entry.hunks.map((hunk) => hunk + 1).join(", ")}`;
			lines.push(truncate(`  ${entry.path} — ${detail}`, width));
		}
	}

	// Commit composer panel (§72).
	if (controller.composer) {
		lines.push("─".repeat(Math.max(0, width)));
		const composer = controller.composer;
		const header = composer.generating
			? `Commit message${composer.amend ? " (amend)" : ""} — generating…`
			: `Commit message${composer.amend ? " (amend)" : ""} — [Enter] commit [Esc] cancel [g] generate [a] amend`;
		lines.push(truncate(header, width));
		const textLines = composer.text.split("\n");
		const cursor = composer.cursor;
		let consumed = 0;
		for (const textLine of textLines) {
			const start = consumed;
			const end = consumed + textLine.length;
			let display = textLine;
			if (cursor >= start && cursor <= end) {
				const offset = cursor - start;
				display = `${textLine.slice(0, offset)}▮${textLine.slice(offset)}`;
			}
			lines.push(truncate(display, width));
			consumed = end + 1;
		}
		if (cursor >= consumed) {
			lines.push(truncate("▮", width));
		}
	}

	// Action / status bar.
	lines.push("─".repeat(Math.max(0, width)));
	if (controller.pendingConfirm) {
		lines.push(truncate(`${controller.pendingConfirm.prompt} [y/n]`, width));
	} else if (controller.message) {
		lines.push(truncate(controller.message, width));
	} else {
		const mode = controller.hunkMode
			? `hunk ${controller.selectedHunk + 1}/${controller.diff?.parsed?.hunks.length ?? 0}`
			: "file";
		const bar = revision
			? `[↑/↓] move [h] ${controller.hunkMode ? "file" : "hunk"} mode [r]efresh [q]uit — read-only revision mode`
			: `[tab] area [↑/↓] move [h] ${controller.hunkMode ? "file" : "hunk"} mode [s]tage [u]nstage [d]iscard [c]ommit [r]efresh [q]uit — ${mode}`;
		lines.push(truncate(bar, width));
	}
	// Trim to the requested height, keeping the header and action bar.
	if (lines.length > height && height > 2) {
		const kept = lines.slice(0, height - 1);
		kept.push("…");
		return kept;
	}
	return lines;
}

/**
 * The interactive component handed to `ctx.ui.custom()`. Rendering is
 * delegated to the pure renderer so headless tests can call
 * `component.render(width)` directly.
 */
export class GitTuiComponent implements Component {
	constructor(
		private tui: { requestRender(): void },
		controller: GitTuiController,
		private onDone: () => void,
		private options: { height?: number } = {},
	) {
		// Async mutations must trigger a render when they settle.
		controller.setOnChange(() => this.renderChanged());
		void controller.loadDiff();
		this.controller = controller;
	}

	private controller: GitTuiController;

	private renderChanged(): void {
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {}

	handleInput(data: string): void {
		const controller = this.controller;
		// Destructive confirmation takes over the keyboard (§64 explicit intent).
		if (controller.pendingConfirm) {
			if (data === "y") {
				controller.confirmPending();
			} else if (data === "n" || matchesKey(data, "escape")) {
				controller.cancelPending();
			} else if (data === "q") {
				this.onDone();
				return;
			}
			this.tui.requestRender();
			return;
		}
		// The composer takes over the keyboard while it is open (§72);
		// typed characters must reach the message, not the file list.
		if (controller.composer) {
			this.composerInput(data);
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			if (controller.hunkMode) controller.moveHunk(-1);
			else controller.select(-1);
			void this.reload();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			if (controller.hunkMode) controller.moveHunk(1);
			else controller.select(1);
			void this.reload();
			return;
		}
		if (matchesKey(data, "tab")) {
			controller.switchArea();
			void this.reload();
			return;
		}
		if (data === "h") {
			if (controller.hunkMode) {
				controller.exitHunkMode();
			} else if (!controller.enterHunkMode()) {
				controller.message = "No textual hunks for this selection.";
			}
			this.tui.requestRender();
			return;
		}
		if (data === "s") {
			controller.primary("stage");
			return;
		}
		if (data === "u") {
			controller.primary("unstage");
			return;
		}
		if (data === "d") {
			controller.primary("discard");
			this.tui.requestRender();
			return;
		}
		if (data === "r") {
			controller.refreshNow();
			return;
		}
		if (data === "c") {
			controller.openComposer();
			this.tui.requestRender();
			return;
		}
		// A produced plan takes over: y applies, n cancels (§70).
		if (controller.pendingAiPlan) {
			if (data === "y") {
				controller.confirmAiPlan();
			} else if (data === "n" || matchesKey(data, "escape")) {
				controller.cancelAiPlan();
			}
			this.tui.requestRender();
			return;
		}
		if (data === "a") {
			controller.openAiPrompt();
			this.tui.requestRender();
			return;
		}
		// The AI prompt takes over the keyboard while it is open.
		if (controller.aiPrompt) {
			this.aiPromptInput(data);
			return;
		}
		if (data === "q" || matchesKey(data, "escape")) {
			this.onDone();
			return;
		}
	}

	/** Keyboard handling while the AI staging prompt is open. */
	private aiPromptInput(data: string): void {
		const controller = this.controller;
		if (matchesKey(data, "escape")) {
			controller.closeAiPrompt();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			controller.planAiStageNow();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "backspace")) {
			controller.aiBackspace();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "left")) {
			controller.aiMove(-1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			controller.aiMove(1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up")) {
			controller.aiMoveLine(-1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			controller.aiMoveLine(1);
			this.tui.requestRender();
			return;
		}
		if (data.length === 1 && data >= " ") {
			controller.aiInsert(data);
			this.tui.requestRender();
		}
	}

	/** Keyboard handling while the commit composer is open. */
	private composerInput(data: string): void {
		const controller = this.controller;
		if (matchesKey(data, "escape")) {
			controller.closeComposer();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			controller.commitNow();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "backspace")) {
			controller.composerBackspace();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "left")) {
			controller.composerMove(-1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			controller.composerMove(1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up")) {
			controller.composerMoveLine(-1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			controller.composerMoveLine(1);
			this.tui.requestRender();
			return;
		}
		// Plain keys act as editing commands; printable text is inserted.
		if (data === "g") {
			controller.generateMessage();
			this.tui.requestRender();
			return;
		}
		if (data === "a") {
			controller.toggleAmend();
			this.tui.requestRender();
			return;
		}
		if (data.length === 1 && data >= " ") {
			controller.composerInsert(data);
			this.tui.requestRender();
		}
	}

	private async reload(): Promise<void> {
		await this.controller.loadDiff();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const height = this.options.height ?? 40;
		return renderGitTui(this.controller, width, height);
	}
}
