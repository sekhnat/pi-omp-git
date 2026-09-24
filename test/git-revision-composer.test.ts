/**
 * Ticket 19 acceptance tests: revision inspection mode (§67–§69) and the
 * commit composer (§72, §83–§85), exercised headlessly against real git
 * in temporary repositories.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectCommitStyle,
	executeCommit,
	normalizeCommitMessage,
} from "../src/git/commit-ops.ts";
import {
	collectRevisionStatus,
	fetchRevisionFileDiff,
	parseRevisionNameStatus,
	resolveRevision,
} from "../src/git/revision.ts";
import { createGitRunner, type GitRunner } from "../src/git/runner.ts";
import {
	buildGitUiState,
	collectGitRawStatus,
	emptyGitUiState,
} from "../src/git/status-model.ts";
import { GitTuiController, renderGitTui } from "../src/git/tui.ts";
import type { NestedSessionFactory } from "../src/github/nested-agent.ts";

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

function initRepo(): { path: string; git: GitRunner } {
	const path = mkdtempSync(join(tmpdir(), "pi-omp-git-rev-"));
	tempDirs.push(path);
	git(["init", "-q", "--initial-branch=main", "."], path);
	git(["config", "user.email", "t@t"], path);
	git(["config", "user.name", "t"], path);
	writeFileSync(join(path, "f.txt"), "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");
	writeFileSync(join(path, "keep.txt"), "1\n2\n3\n");
	git(["add", "-A", "."], path);
	git(["commit", "-q", "-m", "init"], path);
	return { path, git: createGitRunner({}) };
}

async function worktreeController(repo: {
	path: string;
	git: GitRunner;
}): Promise<GitTuiController> {
	const raw = await collectGitRawStatus({ git: repo.git }, repo.path);
	const state = buildGitUiState(raw);
	return new GitTuiController({ git: repo.git, cwd: repo.path }, state);
}

function scriptSessionFactory(response: string): {
	factory: NestedSessionFactory;
	prompts: string[];
} {
	const prompts: string[] = [];
	const factory: NestedSessionFactory = async (factoryOptions) => {
		void factoryOptions;
		return {
			session: {
				prompt: async (text: string) => {
					prompts.push(text);
				},
				abort: () => {},
				getLastAssistantText: () => response,
				dispose: () => {},
			},
		};
	};
	return { factory, prompts };
}

describe("revision mode (§67)", () => {
	it("resolves a revision with parent and subject", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "f.txt"), "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n");
		git(["commit", "-qam", "change f"], repo.path);
		const info = await resolveRevision({ git: repo.git }, repo.path, "HEAD");
		expect(info.ref).toBe("HEAD");
		expect(info.subject).toBe("change f");
		expect(info.parent).toBe(git(["rev-parse", "HEAD~1"], repo.path).trim());
		expect(info.commit).toBe(git(["rev-parse", "HEAD"], repo.path).trim());
	});

	it("rejects unknown revisions", async () => {
		const repo = initRepo();
		await expect(
			resolveRevision({ git: repo.git }, repo.path, "no-such-ref"),
		).rejects.toThrow(/Unknown revision/);
	});

	it("lists changed files with parent-vs-revision diffs", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "f.txt"), "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n");
		writeFileSync(join(repo.path, "added.txt"), "new\n");
		rmSync(join(repo.path, "keep.txt"));
		git(["add", "-A", "."], repo.path);
		git(["commit", "-qam", "mixed change"], repo.path);
		const info = await resolveRevision({ git: repo.git }, repo.path, "HEAD");
		const state = await collectRevisionStatus(
			{ git: repo.git },
			repo.path,
			info,
		);
		const paths = state.files.map((file) => `${file.state}:${file.path}`);
		expect(paths).toContain("M:f.txt");
		expect(paths).toContain("A:added.txt");
		expect(paths).toContain("D:keep.txt");

		const diff = await fetchRevisionFileDiff({ git: repo.git }, state, "f.txt");
		expect(diff.text).toContain("+B");
		expect(diff.text).not.toContain("keep");
		// Only the revision's change is shown — not working-tree state.
		const added = await fetchRevisionFileDiff(
			{ git: repo.git },
			state,
			"added.txt",
		);
		expect(added.parsed?.hunks.length).toBe(1);
	});

	it("handles root commits against the empty tree", async () => {
		const repo = initRepo();
		const sha = git(["rev-parse", "HEAD"], repo.path).trim();
		await resolveRevision({ git: repo.git }, repo.path, sha);
		// Delete history: create an orphan root commit.
		git(["checkout", "-q", "--orphan", "fresh"], repo.path);
		git(["rm", "-q", "-rf", "."], repo.path);
		writeFileSync(join(repo.path, "only.txt"), "solo\n");
		git(["add", "-A", "."], repo.path);
		git(["commit", "-qam", "root"], repo.path);
		const rootInfo = await resolveRevision(
			{ git: repo.git },
			repo.path,
			"fresh",
		);
		expect(rootInfo.parent).toBeUndefined();
		const state = await collectRevisionStatus(
			{ git: repo.git },
			repo.path,
			rootInfo,
		);
		expect(state.files.map((file) => file.path)).toEqual(["only.txt"]);
		const diff = await fetchRevisionFileDiff(
			{ git: repo.git },
			state,
			"only.txt",
		);
		expect(diff.text).toContain("+solo");
	});

	it("reports oversized and binary files without loading content", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "huge.txt"), "y".repeat(4 * 1024 * 1024 + 2));
		writeFileSync(join(repo.path, "blob.bin"), "\u0000\u0001data");
		git(["add", "-A", "."], repo.path);
		git(["commit", "-qam", "big"], repo.path);
		const info = await resolveRevision({ git: repo.git }, repo.path, "HEAD");
		const state = await collectRevisionStatus(
			{ git: repo.git },
			repo.path,
			info,
		);
		const huge = await fetchRevisionFileDiff(
			{ git: repo.git },
			state,
			"huge.txt",
		);
		expect(huge.oversized).toBe(true);
		expect(huge.text).toBeUndefined();
		const blob = state.files.find((file) => file.path === "blob.bin");
		expect(blob?.binary).toBe(true);
		const binDiff = await fetchRevisionFileDiff(
			{ git: repo.git },
			state,
			"blob.bin",
		);
		expect(binDiff.binary).toBe(true);
		expect(binDiff.text).toBeUndefined();
	});

	it("recognizes LFS pointers by blob content", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "ptr.bin"),
			"version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f265da096dbdfe6b4b1e0b7a2d4e5f6a7b8c9d0e1f2a\nsize 1\n",
		);
		git(["add", "ptr.bin"], repo.path);
		git(["commit", "-qam", "lfs"], repo.path);
		const info = await resolveRevision({ git: repo.git }, repo.path, "HEAD");
		const state = await collectRevisionStatus(
			{ git: repo.git },
			repo.path,
			info,
			{
				lfsProbe: (content) => content.startsWith("version https://git-lfs"),
			},
		);
		expect(state.files.find((file) => file.path === "ptr.bin")?.lfs).toBe(true);
	});

	it("disables mutations and the composer while rendering read-only", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "f.txt"), "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n");
		git(["commit", "-qam", "change"], repo.path);
		const info = await resolveRevision({ git: repo.git }, repo.path, "HEAD");
		const revisionState = await collectRevisionStatus(
			{ git: repo.git },
			repo.path,
			info,
		);
		const controller = new GitTuiController(
			{ git: repo.git, cwd: repo.path },
			emptyGitUiState(repo.path),
			revisionState,
		);
		await controller.loadDiff();
		expect(controller.isRevisionMode()).toBe(true);
		expect(controller.currentPath()).toBe("f.txt");

		controller.primary("stage");
		expect(controller.message).toContain("read-only");
		controller.primary("discard");
		expect(controller.message).toContain("read-only");
		controller.openComposer();
		expect(controller.message).toContain("read-only");
		expect(controller.composer).toBeNull();
		controller.switchArea();
		expect(controller.currentPath()).toBe("f.txt");

		// Working tree untouched and the layout reflects revision mode.
		expect(git(["status", "--porcelain=v2"], repo.path).trim()).toBe("");
		controller.message = null;
		const lines = renderGitTui(controller, 100, 40);
		const text = lines.join("\n");
		expect(lines[0]).toContain("revision HEAD");
		expect(lines[0]).toContain("(read-only)");
		expect(text).toContain("Changes in HEAD");
		expect(text).toContain("read-only revision mode");
		expect(text).not.toContain("[s]tage");
	});

	it("supports hunk mode on revision diffs", async () => {
		const repo = initRepo();
		// Changes far enough apart that git keeps two hunks (>6 context lines).
		writeFileSync(
			join(repo.path, "f.txt"),
			"a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nM\nn\no\np\n",
		);
		git(["commit", "-qam", "two hunks"], repo.path);
		const info = await resolveRevision({ git: repo.git }, repo.path, "HEAD");
		const revisionState = await collectRevisionStatus(
			{ git: repo.git },
			repo.path,
			info,
		);
		const controller = new GitTuiController(
			{ git: repo.git, cwd: repo.path },
			emptyGitUiState(repo.path),
			revisionState,
		);
		await controller.loadDiff();
		expect(controller.enterHunkMode()).toBe(true);
		expect(controller.diff?.parsed?.hunks.length).toBe(2);
	});
});

describe("parseRevisionNameStatus", () => {
	it("parses name-status lines and skips the commit header", () => {
		const files = parseRevisionNameStatus(
			"abc123\nM\tf.txt\nA\tnew.txt\nD\told.txt\nT\tsym.txt\n",
		);
		expect(files.map((file) => `${file.state}:${file.path}`)).toEqual([
			"M:f.txt",
			"A:new.txt",
			"D:old.txt",
			"T:sym.txt",
		]);
	});
});

describe("commit composer (§72)", () => {
	it("opens with an amend hint when nothing is staged", async () => {
		const repo = initRepo();
		const controller = new GitTuiController(
			{ git: repo.git, cwd: repo.path },
			emptyGitUiState(repo.path),
		);
		controller.openComposer();
		expect(controller.composer).not.toBeNull();
		expect(controller.message).toContain("Nothing staged");
	});

	it("commits a manual message with HEAD verification", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "f.txt"), "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n");
		git(["add", "f.txt"], repo.path);
		const controller = await worktreeController(repo);
		controller.openComposer();
		controller.composerInsert("fix(core): correct the parser");
		controller.commitNow();
		await new Promise((resolve) => setTimeout(resolve, 80));
		const head = git(["rev-parse", "HEAD"], repo.path).trim();
		const subject = git(["log", "-1", "--format=%s"], repo.path).trim();
		expect(subject).toBe("fix(core): correct the parser");
		expect(controller.composer).toBeNull();
		expect(controller.message).toContain(`Committed ${head.slice(0, 8)}`);
	});

	it("generates an editable Conventional Commits message via the nested agent", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "f.txt"), "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n");
		git(["add", "f.txt"], repo.path);
		const { factory, prompts } = scriptSessionFactory(
			"feat(parser): handle repeated delimiter\n\nLoop the split twice.",
		);
		const raw = await collectGitRawStatus({ git: repo.git }, repo.path);
		const controller = new GitTuiController(
			{
				git: repo.git,
				cwd: repo.path,
				createNestedSession: factory,
			},
			buildGitUiState(raw),
		);
		controller.openComposer();
		controller.generateMessage();
		for (let spin = 0; spin < 100 && !controller.composer?.text; spin += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(prompts.length).toBe(1);
		expect(prompts[0]).toContain("staged changes");
		expect(controller.composer?.text).toBe(
			"feat(parser): handle repeated delimiter\n\nLoop the split twice.",
		);
		// The user edits the generated text before execution (§72):
		// the cursor sits at the end, so replace the trailing period.
		controller.composerBackspace();
		controller.composerInsert("!");
		controller.commitNow();
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(git(["log", "-1", "--format=%B"], repo.path).trim()).toBe(
			"feat(parser): handle repeated delimiter\n\nLoop the split twice!",
		);
	});

	it("amends the HEAD commit", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "f.txt"), "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n");
		git(["add", "f.txt"], repo.path);
		git(["commit", "-qm", "wrong message"], repo.path);
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();

		const controller = await worktreeController(repo);
		controller.openComposer();
		controller.toggleAmend();
		controller.composerInsert("fix: better message");
		controller.commitNow();
		await new Promise((resolve) => setTimeout(resolve, 80));
		const headAfter = git(["rev-parse", "HEAD"], repo.path).trim();
		expect(headAfter).not.toBe(headBefore);
		expect(git(["log", "-1", "--format=%s"], repo.path).trim()).toBe(
			"fix: better message",
		);
		expect(controller.message).toContain("Amended");
	});

	it("preserves hook stderr and identifies the failed step", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "f.txt"), "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n");
		git(["add", "f.txt"], repo.path);
		const hooks = join(repo.path, ".git", "hooks");
		writeFileSync(
			join(hooks, "pre-commit"),
			"#!/bin/sh\necho 'lint failed hard' >&2\nexit 1\n",
		);
		statSync(hooks);
		execFileSync("chmod", ["+x", join(hooks, "pre-commit")]);

		const controller = await worktreeController(repo);
		controller.openComposer();
		controller.composerInsert("feat: something");
		controller.commitNow();
		await new Promise((resolve) => setTimeout(resolve, 120));
		// git does not name the hook; the step and the hook's stderr are preserved.
		expect(controller.message).toContain("Commit failed");
		expect(controller.message).toContain("lint failed hard");
		// HEAD unchanged, changes still staged.
		expect(git(["status", "--porcelain=v2"], repo.path)).toContain("1 M. ");
	});

	it("refuses an empty message and unchanged HEAD", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "f.txt"), "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n");
		git(["add", "f.txt"], repo.path);
		await expect(
			executeCommit({ git: repo.git, cwd: repo.path }, { message: "   " }),
		).rejects.toThrow(/empty/);
	});
});

describe("message normalization", () => {
	it("strips code fences and rejects list-like output", () => {
		expect(normalizeCommitMessage("```\nfix: thing\n```\n")).toBe("fix: thing");
		expect(normalizeCommitMessage("1. First option\n2. Second")).toBe("");
		expect(normalizeCommitMessage("- maybe this\n- maybe that")).toBe("");
		expect(normalizeCommitMessage("")).toBe("");
	});

	it("collects commit style from recent subjects", async () => {
		const repo = initRepo();
		git(
			["commit", "-q", "--allow-empty", "-m", "feat: prior style"],
			repo.path,
		);
		const subjects = await collectCommitStyle({
			git: repo.git,
			cwd: repo.path,
		});
		expect(subjects).toContain("feat: prior style");
	});
});
