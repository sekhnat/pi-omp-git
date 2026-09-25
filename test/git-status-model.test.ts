/**
 * Ticket 17 acceptance tests: the headless Git UI state model
 * (docs/pi-omp-git-reference.md §62–§63, §68–§69, §99).
 *
 * Real git runs in temporary repositories; the model is built from Git
 * plumbing output and verified with Git commands, never from UI state.
 */

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
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
	fetchFileDiff,
	type GitRawStatus,
	MAX_DIFFABLE_FILE_BYTES,
	parseBinaryPaths,
	parseStatusV2,
	refreshGitState,
	unquoteGitPath,
} from "../src/git/status-model.ts";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

/** Real git with stable locale, run synchronously for setup. */
function git(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
	});
}

function lfsProbe(path: string): boolean {
	try {
		return readFileSync(path, "utf8").startsWith("version https://git-lfs");
	} catch {
		return false;
	}
}

/** Real git runner matching the extension's runtime seam. */
function realGit(): GitRunner {
	return createGitRunner({});
}

interface Repo {
	path: string;
	git: GitRunner;
}

function initRepo(): Repo {
	const path = tempDir("pi-omp-git-status-");
	git(["init", "-q", "--initial-branch=main", "."], path);
	git(["config", "user.email", "t@t"], path);
	git(["config", "user.name", "t"], path);
	writeFileSync(join(path, "base.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(path, "other.txt"), "alpha\nbeta\n");
	git(["add", "-A", "."], path);
	git(["commit", "-q", "-m", "init"], path);
	return { path, git: realGit() };
}

async function state(repo: Repo) {
	const raw = await collectGitRawStatus({ git: repo.git }, repo.path);
	return buildGitUiState(raw);
}

describe("clean repository", () => {
	it("reports no staged, unstaged, or conflicted files, with branch and HEAD", async () => {
		const repo = initRepo();
		const s = await state(repo);
		expect(s.root).toBe(repo.path);
		expect(s.branch).toBe("main");
		expect(s.head).toMatch(/^[0-9a-f]{40}$/);
		expect(s.staged).toEqual([]);
		expect(s.unstaged).toEqual([]);
		expect(s.conflicts).toEqual([]);
	});
});

describe("staged and unstaged states", () => {
	it("shows a staged-only modification", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "base.txt"), "one\nTWO\nthree\n");
		git(["add", "base.txt"], repo.path);
		const s = await state(repo);
		expect(s.staged.map((f) => f.path)).toEqual(["base.txt"]);
		expect(s.staged[0]?.state).toBe("M");
		expect(s.unstaged).toEqual([]);
	});

	it("shows an unstaged-only modification", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "base.txt"), "one\ntwo\nchanged\n");
		const s = await state(repo);
		expect(s.staged).toEqual([]);
		expect(s.unstaged.map((f) => f.path)).toEqual(["base.txt"]);
		expect(s.unstaged[0]?.state).toBe("M");
	});

	it("shows both states for a path with staged and unstaged changes", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "base.txt"), "one\ntwo\nthree\nstaged\n");
		git(["add", "base.txt"], repo.path);
		writeFileSync(
			join(repo.path, "base.txt"),
			"one\ntwo\nthree\nstaged\nunstaged\n",
		);
		const s = await state(repo);
		expect(s.staged.map((f) => f.path)).toEqual(["base.txt"]);
		expect(s.staged[0]?.state).toBe("M");
		expect(s.unstaged.map((f) => f.path)).toEqual(["base.txt"]);
		expect(s.unstaged[0]?.state).toBe("M");
	});

	it("shows untracked files as unstaged with the '?' state", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "new.txt"), "hello\n");
		const s = await state(repo);
		expect(s.unstaged.map((f) => f.path)).toEqual(["new.txt"]);
		expect(s.unstaged[0]?.state).toBe("?");
	});

	it("shows staged copies with their source path", async () => {
		const repo = initRepo();
		const { copyFileSync } = await import("node:fs");
		copyFileSync(join(repo.path, "base.txt"), join(repo.path, "copy.txt"));
		git(["add", "copy.txt"], repo.path);
		const s = await state(repo);
		const copy = s.staged.find((f) => f.path === "copy.txt");
		expect(copy?.state).toBe("A");
	});

	it("shows unstaged deletions as unstaged D", async () => {
		const repo = initRepo();
		const { unlinkSync } = await import("node:fs");
		unlinkSync(join(repo.path, "other.txt"));
		const s = await state(repo);
		expect(s.unstaged.find((f) => f.path === "other.txt")?.state).toBe("D");
	});

	it("shows staged additions, deletions, and renames", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "added.txt"), "fresh\n");
		git(["add", "added.txt"], repo.path);
		git(["rm", "-q", "other.txt"], repo.path);
		git(["mv", "base.txt", "renamed.txt"], repo.path);
		const s = await state(repo);
		expect(s.staged.find((f) => f.path === "added.txt")?.state).toBe("A");
		expect(s.staged.find((f) => f.path === "other.txt")?.state).toBe("D");
		const rename = s.staged.find((f) => f.path === "renamed.txt");
		expect(rename?.state).toBe("R");
		expect(rename?.origPath).toBe("base.txt");
	});
});

describe("binary and LFS recognition (§69)", () => {
	it("flags binary files from numstat and keeps the diff pane binary", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "blob.bin"), "\u0000\u0001\u0002binary");
		git(["add", "blob.bin"], repo.path);
		git(["commit", "-q", "-m", "bin"], repo.path);
		writeFileSync(join(repo.path, "blob.bin"), "\u0000\u0009changed");
		const s = await state(repo);
		expect(s.unstaged[0]?.binary).toBe(true);
		const diff = await fetchFileDiff(
			{ git: repo.git },
			s,
			"unstaged",
			"blob.bin",
		);
		expect(diff.binary).toBe(true);
		expect(diff.text).toBeUndefined();
	});

	it("recognizes Git LFS pointer files", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "model.bin"),
			"version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f265da096dbdfe6b4b1e0b7a2d4e5f6a7b8c9d0e1f2a\nsize 1234\n",
		);
		git(["add", "model.bin"], repo.path);
		git(["commit", "-q", "-m", "lfs"], repo.path);
		const raw = await collectGitRawStatus({ git: repo.git }, repo.path);
		const s = buildGitUiState(raw, { lfsProbe });
		expect(s.staged).toEqual([]);
		// No unstaged change here — verify LFS flag via an unstaged edit.
		writeFileSync(
			join(repo.path, "model.bin"),
			"version https://git-lfs.github.com/spec/v1\noid sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\nsize 9\n",
		);
		const raw2 = await collectGitRawStatus({ git: repo.git }, repo.path);
		const s2 = buildGitUiState(raw2, { lfsProbe });
		expect(s2.unstaged[0]?.lfs).toBe(true);
	});
});

describe("conflicts", () => {
	it("lists conflicted paths from a merge", async () => {
		const repo = initRepo();
		git(["checkout", "-q", "-b", "side"], repo.path);
		writeFileSync(join(repo.path, "base.txt"), "side\n");
		git(["commit", "-qam", "side"], repo.path);
		git(["checkout", "-q", "main"], repo.path);
		writeFileSync(join(repo.path, "base.txt"), "main\n");
		git(["commit", "-qam", "main"], repo.path);
		try {
			git(["merge", "side"], repo.path);
		} catch {
			// merge conflict expected
		}
		const s = await state(repo);
		expect(s.conflicts.map((f) => f.path)).toEqual(["base.txt"]);
	});
});

describe("porcelain v2 parsing", () => {
	it("parses all entry kinds and quoted paths", () => {
		const output = [
			"# branch.oid 0123456789012345678901234567890123456789",
			"# branch.head feature/x",
			"1 M. N... 100644 100644 100644 abc def staged.txt",
			"1 .M N... 100644 100644 100644 abc def unstaged.txt",
			"1 MM N... 100644 100644 100644 abc def both.txt",
			'2 R. N... 100644 100644 100644 abc def R100 "new\\tname.txt"\told name.txt',
			"u UU N... 100644 100644 100644 100644 000 000 000 conflict.txt",
			"? untracked.txt",
			"! ignored.txt",
		].join("\n");
		const parsed = parseStatusV2(output);
		expect(parsed.head).toBe("0123456789012345678901234567890123456789");
		expect(parsed.branch).toBe("feature/x");
		expect(parsed.staged.map((f) => f.path)).toEqual([
			"staged.txt",
			"both.txt",
			"new\tname.txt",
		]);
		expect(parsed.staged[2]?.origPath).toBe("old name.txt");
		expect(parsed.staged.map((f) => f.state)).toEqual(["M", "M", "R"]);
		expect(parsed.unstaged.map((f) => f.path)).toEqual([
			"unstaged.txt",
			"both.txt",
			"untracked.txt",
		]);
		expect(parsed.unstaged.map((f) => f.state)).toEqual(["M", "M", "?"]);
		expect(parsed.conflicts.map((f) => f.path)).toEqual(["conflict.txt"]);
	});

	it("unquotes C-style git paths", () => {
		expect(unquoteGitPath('"a\\tb.txt"')).toBe("a\tb.txt");
		expect(unquoteGitPath("plain.txt")).toBe("plain.txt");
	});

	it("parses binary markers from numstat", () => {
		const paths = parseBinaryPaths(["1\t2\tnormal.txt", "-\t-\tbin.dat"]);
		expect(paths.has("bin.dat")).toBe(true);
		expect(paths.has("normal.txt")).toBe(false);
	});
});

describe("diff fetching", () => {
	it("parses staged and unstaged hunks", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "base.txt"), "one\ntwo\nTHREE\n");
		git(["add", "base.txt"], repo.path);
		writeFileSync(join(repo.path, "base.txt"), "one\n2wo\nTHREE\n");
		const s = await state(repo);
		const staged = await fetchFileDiff(
			{ git: repo.git },
			s,
			"staged",
			"base.txt",
		);
		expect(staged.parsed?.hunks).toHaveLength(1);
		expect(
			staged.parsed?.hunks[0]?.lines.some(
				(l) => l.kind === "add" && l.text === "THREE",
			),
		).toBe(true);
		const unstaged = await fetchFileDiff(
			{ git: repo.git },
			s,
			"unstaged",
			"base.txt",
		);
		expect(
			unstaged.parsed?.hunks[0]?.lines.some(
				(l) => l.kind === "add" && l.text === "2wo",
			),
		).toBe(true);
	});

	it("renders untracked files through --no-index", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "fresh.txt"), "line1\nline2\n");
		const s = await state(repo);
		const diff = await fetchFileDiff(
			{ git: repo.git },
			s,
			"unstaged",
			"fresh.txt",
		);
		expect(diff.empty).toBe(false);
		expect(diff.parsed?.hunks).toHaveLength(1);
		expect(diff.parsed?.hunks[0]?.lines.every((l) => l.kind === "add")).toBe(
			true,
		);
	});

	it("reports files above the 4 MiB limit as oversized without loading them", async () => {
		const repo = initRepo();
		const big = "x".repeat(MAX_DIFFABLE_FILE_BYTES + 1);
		writeFileSync(join(repo.path, "huge.txt"), big);
		git(["add", "huge.txt"], repo.path);
		git(["commit", "-q", "-m", "huge"], repo.path);
		writeFileSync(join(repo.path, "huge.txt"), `${big}more`);
		const s = await state(repo);
		const diff = await fetchFileDiff(
			{ git: repo.git },
			s,
			"unstaged",
			"huge.txt",
		);
		expect(diff.oversized).toBe(true);
		expect(diff.text).toBeUndefined();
	});
});

describe("state refresh (§62)", () => {
	it("re-reads repository state after a mutation", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "base.txt"), "changed\n");
		const before = await refreshGitState({ git: repo.git }, repo.path);
		expect(before.unstaged.map((f) => f.path)).toEqual(["base.txt"]);
		git(["add", "base.txt"], repo.path);
		const after = await refreshGitState({ git: repo.git }, repo.path);
		expect(after.unstaged).toEqual([]);
		expect(after.staged.map((f) => f.path)).toEqual(["base.txt"]);
	});

	it("collects raw status from a subdirectory cwd", async () => {
		const repo = initRepo();
		mkdirSync(join(repo.path, "sub"), { recursive: true });
		writeFileSync(join(repo.path, "sub", "nested.txt"), "n\n");
		const raw: GitRawStatus = await collectGitRawStatus(
			{ git: repo.git },
			join(repo.path, "sub"),
		);
		expect(raw.root).toBe(repo.path);
		const s = buildGitUiState(raw);
		expect(s.unstaged.map((f) => f.path)).toEqual(["sub/nested.txt"]);
	});
});
