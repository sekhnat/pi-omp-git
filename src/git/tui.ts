/**
 * `/git` TUI: controller plus component (docs/pi-omp-git-reference.md
 * §60–§61, §64–§66, tickets 17–18).
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
	private diffSide: "staged" | "unstaged" = "unstaged";
	private diffPath: string | null = null;

	constructor(
		private options: { git: GitRunner; cwd: string; onChange?: () => void },
		initialState: GitUiState,
	) {
		this.state = initialState;
		this.rebuildRows();
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
	private async run(action: () => Promise<void>): Promise<void> {
		try {
			await action();
			this.message = null;
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
	const repoName = state.root.split("/").filter(Boolean).pop() ?? state.root;
	const headShort = state.head ? state.head.slice(0, 8) : "—";
	const lines: string[] = [];

	// Header: repository / branch / HEAD.
	lines.push(
		truncate(
			`${repoName} — ${state.branch ?? "(detached)"} @ ${headShort}`,
			width,
		),
	);
	lines.push("─".repeat(Math.max(0, width)));

	// Sidebar rows with section headers.
	const sidebarWidth = Math.max(16, Math.min(40, Math.floor(width / 3)));
	const diffWidth = Math.max(20, width - sidebarWidth - 1);

	const sidebar: string[] = [];
	const sections: Array<{ title: string; area: Area }> = [
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
		lines.push(
			truncate(
				`[tab] area [↑/↓] move [h] ${controller.hunkMode ? "file" : "hunk"} mode [s]tage [u]nstage [d]iscard [r]efresh [q]uit — ${mode}`,
				width,
			),
		);
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
		if (data === "q" || matchesKey(data, "escape")) {
			this.onDone();
			return;
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
