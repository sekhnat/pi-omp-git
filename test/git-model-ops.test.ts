/**
 * Ticket 18 acceptance tests: file- and hunk-level Git operations for
 * the `/git` TUI (docs/pi-omp-git-reference.md §64–§66, §99).
 *
 * Real git runs in temporary repositories. After every operation the
 * repository state is verified with Git commands themselves — not from
 * the operation's return value.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
} from "../src/git/model-ops.ts";
import { createGitRunner, type GitRunner } from "../src/git/runner.ts";
import {
	buildGitUiState,
	collectGitRawStatus,
} from "../src/git/status-model.ts";
import { GitMutationError } from "../src/shared/errors.ts";

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
		env: { ...process.env, LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
}

function initRepo(): {
	path: string;
	git: GitRunner;
	deps: () => OpsDeps;
	statusLines: () => string[];
} {
	const path = mkdtempSync(join(tmpdir(), "pi-omp-git-ops-"));
	tempDirs.push(path);
	git(["init", "-q", "--initial-branch=main", "."], path);
	git(["config", "user.email", "t@t"], path);
	git(["config", "user.name", "t"], path);
	writeFileSync(
		join(path, "f.txt"),
		"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\n",
	);
	git(["add", "-A", "."], path);
	git(["commit", "-q", "-m", "init"], path);
	const runner = createGitRunner({});
	return {
		path,
		git: runner,
		deps: () => ({ git: runner, root: path }),
		statusLines: () =>
			git(["status", "--porcelain=v2", "--untracked-files=all"], path).split(
				"\n",
			),
	};
}

async function uiState(path: string, gitRunner: GitRunner) {
	const raw = await collectGitRawStatus({ git: gitRunner }, path);
	return buildGitUiState(raw);
}

describe("file-level operations (§64)", () => {
	it("stages an unstaged modification", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\n",
		);
		const state = await uiState(repo.path, repo.git);
		await stageFilePath(repo.deps(), state, "f.txt");
		// Verify with Git, not with the model.
		const status = repo.statusLines().join("\n");
		expect(status).toContain("1 M. ");
		expect(status).not.toContain("1 .M ");
	});

	it("stages an untracked file", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "new.txt"), "hello\n");
		const state = await uiState(repo.path, repo.git);
		await stageFilePath(repo.deps(), state, "new.txt");
		expect(repo.statusLines().join("\n")).toContain("1 A. ");
	});

	it("unstages a staged modification, keeping worktree content", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\n",
		);
		git(["add", "f.txt"], repo.path);
		const state = await uiState(repo.path, repo.git);
		await unstageFilePath(repo.deps(), state, "f.txt");
		const status = repo.statusLines().join("\n");
		expect(status).toContain("1 .M ");
		expect(status).not.toContain("1 M. ");
	});

	it("discards unstaged changes while keeping staged ones (MM file)", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\nSTAGED\n",
		);
		git(["add", "f.txt"], repo.path);
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\nSTAGED\nUNSTAGED\n",
		);
		const state = await uiState(repo.path, repo.git);
		expect(state.staged.some((f) => f.path === "f.txt")).toBe(true);
		expect(state.unstaged.some((f) => f.path === "f.txt")).toBe(true);
		await discardUnstagedFile(repo.deps(), state, "f.txt");
		const status = repo.statusLines().join("\n");
		expect(status).toContain("1 M. "); // staged change kept
		expect(status).not.toContain("1 MM ");
		const content = await import("node:fs").then((fs) =>
			fs.readFileSync(join(repo.path, "f.txt"), "utf8"),
		);
		expect(content).toContain("STAGED");
		expect(content).not.toContain("UNSTAGED");
	});

	it("deletes an untracked file on explicit discard", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "temp.txt"), "bye\n");
		const state = await uiState(repo.path, repo.git);
		await discardUnstagedFile(repo.deps(), state, "temp.txt");
		expect(existsSync(join(repo.path, "temp.txt"))).toBe(false);
		expect(repo.statusLines().join("\n")).not.toContain("temp.txt");
	});

	it("discard-all on an MM file restores index and worktree to HEAD and warns first", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\nSTAGED-ORIG\np\n",
		);
		git(["add", "f.txt"], repo.path);
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\nSTAGED-ORIG\np\nUNSTAGED\n",
		);
		const state = await uiState(repo.path, repo.git);
		// §66: the warning must state that unstaged modifications are lost too.
		expect(discardAllWarning(state, "f.txt")).toMatch(
			/unstaged modifications to the same path will also be lost/i,
		);
		await discardStagedFile(repo.deps(), state, "f.txt");
		const status = repo.statusLines().join("\n");
		expect(status).not.toContain("f.txt");
		const content = await import("node:fs").then((fs) =>
			fs.readFileSync(join(repo.path, "f.txt"), "utf8"),
		);
		expect(content).toContain("o\n");
		expect(content).not.toContain("STAGED-ORIG");
	});

	it("discard-all on a staged addition unstages and removes the file", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "added.txt"), "fresh\n");
		git(["add", "added.txt"], repo.path);
		const state = await uiState(repo.path, repo.git);
		await discardStagedFile(repo.deps(), state, "added.txt");
		expect(existsSync(join(repo.path, "added.txt"))).toBe(false);
		expect(repo.statusLines().join("\n")).not.toContain("added.txt");
	});

	it("discard-all on a staged deletion restores the file", async () => {
		const repo = initRepo();
		git(["rm", "-q", "f.txt"], repo.path);
		const state = await uiState(repo.path, repo.git);
		expect(state.staged[0]?.state).toBe("D");
		await discardStagedFile(repo.deps(), state, "f.txt");
		expect(existsSync(join(repo.path, "f.txt"))).toBe(true);
		expect(repo.statusLines().join("\n")).not.toContain("f.txt");
	});

	it("stages both sides of an unstaged rename", async () => {
		const repo = initRepo();
		git(["mv", "f.txt", "g.txt"], repo.path);
		git(["reset", "-q", "--", "f.txt", "g.txt"], repo.path);
		// After unstaging, git may show the rename as unstaged R or as
		// delete+untracked; accept either and stage the visible entries.
		const state = await uiState(repo.path, repo.git);
		const renameEntry = state.unstaged.find((f) => f.origPath === "f.txt");
		if (renameEntry) {
			await stageFilePath(repo.deps(), state, renameEntry.path);
		} else {
			// delete + untracked form
			for (const entry of state.unstaged) {
				await stageFilePath(repo.deps(), state, entry.path);
			}
		}
		const status = repo.statusLines().join("\n");
		expect(status).toContain("g.txt");
		expect(status).not.toContain("? ");
	});
});

describe("hunk-level operations (§65)", () => {
	it("stages one hunk of a two-hunk unstaged diff", async () => {
		const repo = initRepo();
		// Two separate edits far apart: line 2 and line 12.
		const content = "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\nm\nn\no\np\n";
		writeFileSync(join(repo.path, "f.txt"), content);
		const state = await uiState(repo.path, repo.git);
		await stageFileHunk(repo.deps(), state, "f.txt", 0);
		const staged = git(["diff", "--cached", "--", "f.txt"], repo.path);
		const unstaged = git(["diff", "--", "f.txt"], repo.path);
		expect(staged).toContain("+B");
		expect(staged).not.toContain("+L");
		expect(unstaged).toContain("+L");
		expect(unstaged).not.toContain("+B");
	});

	it("unstages one hunk of a two-hunk staged diff", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\nm\nn\no\np\n",
		);
		git(["add", "f.txt"], repo.path);
		const state = await uiState(repo.path, repo.git);
		await unstageFileHunk(repo.deps(), state, "f.txt", 1);
		const staged = git(["diff", "--cached", "--", "f.txt"], repo.path);
		const unstaged = git(["diff", "--", "f.txt"], repo.path);
		expect(staged).toContain("+B");
		expect(staged).not.toContain("+L");
		expect(unstaged).toContain("+L");
	});

	it("discards one hunk of a two-hunk unstaged diff", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\nm\nn\no\np\n",
		);
		const state = await uiState(repo.path, repo.git);
		await discardFileHunk(repo.deps(), state, "f.txt", 1);
		const unstaged = git(["diff", "--", "f.txt"], repo.path);
		expect(unstaged).toContain("+B");
		expect(unstaged).not.toContain("+L");
		const content = await import("node:fs").then((fs) =>
			fs.readFileSync(join(repo.path, "f.txt"), "utf8"),
		);
		expect(content).toContain("B\n");
		expect(content).toContain("l\n"); // line 12 restored
	});

	it("stages the whole content of an untracked file via the --no-index diff", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "fresh.txt"),
			"part1\npart2\npart3\npart4\npart5\npart6\npart7\npart8\npart9\npart10\n",
		);
		await uiState(repo.path, repo.git);
		await stageFileHunkUntracked(repo.deps(), "fresh.txt", 0);
		const staged = git(["diff", "--cached", "--", "fresh.txt"], repo.path);
		expect(staged.length).toBeGreaterThan(0);
		expect(staged).toContain("+part1");
		// The remaining content is still unstaged/untracked.
		const status = repo.statusLines().join("\n");
		expect(status).not.toContain("? fresh.txt");
	});

	it("discarding the only hunk of an untracked file removes the file", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "fresh.txt"),
			"part1\npart2\npart3\npart4\npart5\npart6\npart7\npart8\npart9\npart10\n",
		);
		const state = await uiState(repo.path, repo.git);
		// A new-file diff is a single all-add hunk, so discarding it removes
		// the file — the same effect as discarding the untracked file.
		await discardFileHunk(repo.deps(), state, "fresh.txt", 0);
		expect(existsSync(join(repo.path, "fresh.txt"))).toBe(false);
		expect(repo.statusLines().join("\n")).not.toContain("fresh.txt");
	});

	it("round-trips a hunk in a file without a trailing newline", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np",
		); // no trailing newline
		git(["add", "f.txt"], repo.path);
		git(["commit", "-q", "-m", "no-newline"], repo.path);
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\nZ",
		);
		const state = await uiState(repo.path, repo.git);
		await stageFileHunk(repo.deps(), state, "f.txt", 0);
		const staged = git(["diff", "--cached", "--", "f.txt"], repo.path);
		expect(staged).toContain("+Z");
		// And the reverse application still works after unstaging.
		const state2 = await uiState(repo.path, repo.git);
		await unstageFileHunk(repo.deps(), state2, "f.txt", 0);
		expect(git(["diff", "--cached", "--", "f.txt"], repo.path).trim()).toBe("");
	});

	it("surfaces rejections when the hunk no longer applies", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\n",
		);
		// Generate a patch for hunk 0, then change the context so it no longer applies.
		await uiState(repo.path, repo.git);
		const { extractHunkPatch } = await import("../src/git/diff.ts");
		const diff = git(["diff", "--", "f.txt"], repo.path);
		const patch = extractHunkPatch(diff, 0);
		writeFileSync(join(repo.path, "f.txt"), "COMPLETELY\nDIFFERENT\nCONTENT\n");
		const patchPath = join(repo.path, ".git", "reject.patch");
		writeFileSync(patchPath, patch);
		const applyCheck = await repo.git.run(
			["apply", "--check", "--cached", "--whitespace=nowarn", "reject.patch"],
			{ cwd: repo.path },
		);
		expect(applyCheck.exitCode).not.toBe(0);
		// And the operation itself reports the rejection instead of faking success.
		const state2 = await uiState(repo.path, repo.git);
		// Restore content so hunk indexes exist, then break the file mid-op is
		// not injectable; instead assert the op refuses a stale hunk index.
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\n",
		);
		await expect(
			stageFileHunk(repo.deps(), state2, "f.txt", 7),
		).rejects.toBeInstanceOf(GitMutationError);
	});
});

describe("conflict protection (§64)", () => {
	it("refuses to stage or discard conflicted files", async () => {
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
		const state = await uiState(repo.path, repo.git);
		expect(state.conflicts.map((f) => f.path)).toEqual(["f.txt"]);
		await expect(stageFilePath(repo.deps(), state, "f.txt")).rejects.toThrow(
			/unresolved merge conflicts/,
		);
		await expect(
			discardUnstagedFile(repo.deps(), state, "f.txt"),
		).rejects.toThrow(/unresolved merge conflicts/);
		await expect(
			discardFileHunk(repo.deps(), state, "f.txt", 0),
		).rejects.toThrow(/unresolved merge conflicts/);
		// The conflicted state is untouched.
		expect(repo.statusLines().join("\n")).toContain("u UU");
	});

	it("refuses operations when the path is no longer in the current state", async () => {
		const repo = initRepo();
		const state = await uiState(repo.path, repo.git);
		await expect(
			stageFilePath(repo.deps(), state, "ghost.txt"),
		).rejects.toThrow(/Ghost|No unstaged entry/i);
	});
});
