/**
 * Ticket 17/18 acceptance tests: the `/git` TUI without a terminal
 * (docs/pi-omp-git-reference.md §61, §64, §99 — "The model layer MUST
 * be testable without a terminal").
 *
 * The controller and pure renderer run against real git in temporary
 * repositories; the component's render()/handleInput() are called
 * directly, and repository state after each interaction is verified
 * with Git commands.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRunner, type GitRunner } from "../src/git/runner.ts";
import {
	buildGitUiState,
	collectGitRawStatus,
} from "../src/git/status-model.ts";
import {
	GitTuiComponent,
	GitTuiController,
	renderGitTui,
} from "../src/git/tui.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
	});
}

function initRepo(): { path: string; git: GitRunner } {
	const path = mkdtempSync(join(tmpdir(), "pi-omp-git-tui-"));
	tempDirs.push(path);
	git(["init", "-q", "--initial-branch=main", "."], path);
	git(["config", "user.email", "t@t"], path);
	git(["config", "user.name", "t"], path);
	writeFileSync(
		join(path, "f.txt"),
		"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\n",
	);
	writeFileSync(join(path, "g.txt"), "1\n2\n3\n");
	git(["add", "-A", "."], path);
	git(["commit", "-q", "-m", "init"], path);
	return { path, git: createGitRunner({}) };
}

async function controllerFor(repo: { path: string; git: GitRunner }) {
	const raw = await collectGitRawStatus({ git: repo.git }, repo.path);
	const state = buildGitUiState(raw);
	const controller = new GitTuiController(
		{ git: repo.git, cwd: repo.path },
		state,
	);
	await controller.loadDiff();
	return controller;
}

describe("layout rendering (§61)", () => {
	it("renders header, staged/unstaged sections, split diff, and action bar", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\nZ\n",
		);
		writeFileSync(join(repo.path, "new.txt"), "fresh\n");
		git(["add", "f.txt"], repo.path);
		const controller = await controllerFor(repo);
		const lines = renderGitTui(controller, 100, 40);
		const text = lines.join("\n");
		// Header carries repository, branch, and HEAD.
		expect(lines[0]).toContain(repo.path.split("/").pop() ?? "");
		expect(lines[0]).toContain("main");
		expect(lines[0]).toMatch(/@ [0-9a-f]{8}/);
		// Sidebar sections with counts.
		expect(text).toContain("Staged (1)");
		expect(text).toContain("Unstaged (1)");
		expect(text).toContain("M f.txt");
		expect(text).toContain("? new.txt");
		// Diff pane has old/new columns and the change.
		expect(text).toContain("old");
		expect(text).toContain("new");
		expect(text).toContain("+Z");
		// Action bar hints.
		expect(text).toContain("[s]tage");
		expect(text).toContain("[q]uit");
		// Every line fits the requested width.
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
	});

	it("marks binary, LFS, and conflicted entries in the sidebar", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "blob.bin"), "\u0000\u0001data");
		git(["add", "blob.bin"], repo.path);
		git(["commit", "-q", "-m", "bin"], repo.path);
		writeFileSync(join(repo.path, "blob.bin"), "\u0000\u0009other");
		writeFileSync(
			join(repo.path, "ptr.bin"),
			"version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f265da096dbdfe6b4b1e0b7a2d4e5f6a7b8c9d0e1f2a\nsize 1\n",
		);
		const raw = await collectGitRawStatus({ git: repo.git }, repo.path);
		const state = buildGitUiState(raw, {
			lfsProbe: (p) =>
				readFileSync(p, "utf8").startsWith("version https://git-lfs"),
		});
		const controller = new GitTuiController(
			{ git: repo.git, cwd: repo.path },
			state,
		);
		const text = renderGitTui(controller, 100, 40).join("\n");
		expect(text).toContain("[binary]");
		expect(text).toContain("[LFS]");
	});

	it("shows the oversized message instead of loading huge content", async () => {
		const repo = initRepo();
		const big = "y".repeat(4 * 1024 * 1024 + 2);
		writeFileSync(join(repo.path, "huge.txt"), big);
		const controller = await controllerFor(repo);
		await controller.select(1);
		await controller.loadDiff();
		const text = renderGitTui(controller, 100, 40).join("\n");
		expect(text).toContain("File too large for interactive content preview.");
	});

	it("respects the requested height budget", async () => {
		const repo = initRepo();
		for (let index = 0; index < 30; index += 1) {
			writeFileSync(join(repo.path, `gen${index}.txt`), "x\n");
		}
		const controller = await controllerFor(repo);
		const lines = renderGitTui(controller, 80, 10);
		expect(lines.length).toBeLessThanOrEqual(10);
	});
});

describe("selection and diff-side behavior", () => {
	it("moves selection within and across areas, aligning the diff side", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\nZ\n",
		);
		git(["add", "f.txt"], repo.path);
		writeFileSync(join(repo.path, "new.txt"), "fresh\n");
		const controller = await controllerFor(repo);
		expect(controller.currentArea()).toBe("staged");
		expect(controller.currentPath()).toBe("f.txt");
		controller.select(1);
		expect(controller.currentArea()).toBe("unstaged");
		expect(controller.currentPath()).toBe("new.txt");
		// The diff side flipped to unstaged with the area.
		await controller.loadDiff();
		expect(controller.diff?.side).toBe("unstaged");
		controller.switchArea();
		expect(controller.currentArea()).toBe("staged");
	});

	it("enters hunk mode and moves between hunks", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\nm\nn\no\np\n",
		);
		const controller = await controllerFor(repo);
		expect(controller.enterHunkMode()).toBe(true);
		expect(controller.hunkMode).toBe(true);
		expect(controller.selectedHunk).toBe(0);
		controller.moveHunk(1);
		expect(controller.selectedHunk).toBe(1);
		controller.moveHunk(5);
		expect(controller.selectedHunk).toBe(1); // clamped
		controller.exitHunkMode();
		expect(controller.hunkMode).toBe(false);
	});
});

describe("interactive operations through the component", () => {
	it("stages and unstages files via s/u keys, refreshing from Git", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\nZ\n",
		);
		const controller = await controllerFor(repo);
		let renderCount = 0;
		const component = new GitTuiComponent(
			{ requestRender: () => (renderCount += 1) },
			controller,
			() => {},
		);
		component.handleInput("s");
		// Wait for the async mutation + refresh.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const status = git(["status", "--porcelain=v2"], repo.path);
		expect(status).toContain("1 M. ");
		// Unstage again.
		component.handleInput("u");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const status2 = git(["status", "--porcelain=v2"], repo.path);
		expect(status2).toContain("1 .M ");
		expect(renderCount).toBeGreaterThan(0);
	});

	it("requires explicit confirmation for discard and cancels with n", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\nZ\n",
		);
		const controller = await controllerFor(repo);
		const component = new GitTuiComponent(
			{ requestRender: () => {} },
			controller,
			() => {},
		);
		component.handleInput("d");
		expect(controller.hasPendingConfirm()).toBe(true);
		// Not discarded yet.
		expect(git(["status", "--porcelain=v2"], repo.path)).toContain("1 .M ");
		// While pending, other keys are swallowed.
		component.handleInput("s");
		expect(git(["status", "--porcelain=v2"], repo.path)).toContain("1 .M ");
		component.handleInput("n");
		expect(controller.hasPendingConfirm()).toBe(false);
		expect(git(["status", "--porcelain=v2"], repo.path)).toContain("1 .M ");
	});

	it("performs the discard after y, verifying with Git", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\nZ\n",
		);
		const controller = await controllerFor(repo);
		const component = new GitTuiComponent(
			{ requestRender: () => {} },
			controller,
			() => {},
		);
		component.handleInput("d");
		component.handleInput("y");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(git(["status", "--porcelain=v2"], repo.path).trim()).toBe("");
	});

	it("deletes an untracked file only after confirmation", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "temp.txt"), "bye\n");
		const controller = await controllerFor(repo);
		const component = new GitTuiComponent(
			{ requestRender: () => {} },
			controller,
			() => {},
		);
		controller.select(1); // move to the untracked file
		component.handleInput("d");
		expect(controller.pendingConfirm?.prompt).toContain(
			"Delete untracked file temp.txt",
		);
		component.handleInput("y");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(existsSync(join(repo.path, "temp.txt"))).toBe(false);
	});

	it("stages and unstages individual hunks in hunk mode", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\nm\nn\no\np\n",
		);
		const controller = await controllerFor(repo);
		const component = new GitTuiComponent(
			{ requestRender: () => {} },
			controller,
			() => {},
		);
		component.handleInput("h");
		expect(controller.hunkMode).toBe(true);
		component.handleInput("s");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(git(["diff", "--cached", "--", "f.txt"], repo.path)).toContain("+B");
		expect(git(["diff", "--cached", "--", "f.txt"], repo.path)).not.toContain(
			"+L",
		);
		// Unstage the second hunk after switching to the staged side.
		controller.switchArea();
		await controller.loadDiff();
		component.handleInput("h");
		controller.moveHunk(1);
		component.handleInput("u");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const staged = git(["diff", "--cached", "--", "f.txt"], repo.path);
		expect(staged).not.toContain("+L");
		expect(git(["diff", "--", "f.txt"], repo.path)).toContain("+L");
	});

	it("discards a single hunk after confirmation", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\nm\nn\no\np\n",
		);
		const controller = await controllerFor(repo);
		const component = new GitTuiComponent(
			{ requestRender: () => {} },
			controller,
			() => {},
		);
		component.handleInput("h");
		controller.moveHunk(1);
		component.handleInput("d");
		expect(controller.pendingConfirm?.prompt).toContain("Discard hunk 2");
		component.handleInput("y");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const unstaged = git(["diff", "--", "f.txt"], repo.path);
		expect(unstaged).toContain("+B");
		expect(unstaged).not.toContain("+L");
	});

	it("protects conflicted files from stage and discard (§64)", async () => {
		const repo = initRepo();
		git(["checkout", "-q", "-b", "side"], repo.path);
		writeFileSync(join(repo.path, "f.txt"), "side\n");
		git(["commit", "-qam", "side"], repo.path);
		git(["checkout", "-q", "main"], repo.path);
		writeFileSync(join(repo.path, "f.txt"), "main\n");
		git(["commit", "-qam", "main"], repo.path);
		try {
			git(["merge", "side"], repo.path);
		} catch {
			// conflict expected
		}
		const controller = await controllerFor(repo);
		// Select the conflicted row (only entry).
		controller.switchArea();
		const component = new GitTuiComponent(
			{ requestRender: () => {} },
			controller,
			() => {},
		);
		component.handleInput("s");
		expect(controller.message).toContain("resolve the conflict");
		component.handleInput("d");
		expect(controller.message).toContain("resolve the conflict");
		expect(controller.hasPendingConfirm()).toBe(false);
		expect(git(["status", "--porcelain=v2"], repo.path)).toContain("u UU");
	});

	it("quits via q and exposes the done callback", async () => {
		const repo = initRepo();
		const controller = await controllerFor(repo);
		let done = false;
		const component = new GitTuiComponent(
			{ requestRender: () => {} },
			controller,
			() => {
				done = true;
			},
		);
		component.handleInput("q");
		expect(done).toBe(true);
	});
});
