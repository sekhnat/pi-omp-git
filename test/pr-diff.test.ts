/**
 * Ticket 05 acceptance tests: cached PR diff primary resources (§15–§16).
 * The three virtual views share one parsed/cached unified diff and preserve
 * string-index section boundaries, native read pagination, and row-version
 * notices across reads.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitRunner } from "../src/git/runner.ts";
import { createAvailability } from "../src/github/availability.ts";
import { credentialFingerprint } from "../src/github/cache/auth-key.ts";
import { createGithubCache } from "../src/github/cache/cache.ts";
import { openCacheStore } from "../src/github/cache/db.ts";
import {
	PR_DIFF_UPDATED_NOTICE,
	parseUnifiedDiff,
	renderPrDiff,
} from "../src/github/resources/diffs.ts";
import {
	createGithubReadOverride,
	type GithubReadOverride,
	type ReadToolParams,
} from "../src/github/resources/router.ts";
import { createGhRunner, type GhFixtureMap } from "../src/github/runner.ts";
import { loadConfig } from "../src/shared/config.ts";
import { createRunner, type Exec } from "../src/shared/subprocess.ts";

const MODIFIED_DIFF = [
	"diff --git a/é/emoji😀.ts b/é/emoji😀.ts",
	"index 1234567..89abcde 100644",
	"--- a/é/emoji😀.ts",
	"+++ b/é/emoji😀.ts",
	"@@ -1 +1,2 @@",
	" café",
	"-old value",
	"+new value",
	"+emoji 😀",
	"",
].join("\n");

const ADDED_DIFF = [
	"diff --git a/new.txt b/new.txt",
	"new file mode 100644",
	"index 0000000..1234567",
	"--- /dev/null",
	"+++ b/new.txt",
	"@@ -0,0 +1 @@",
	"+new file",
	"",
].join("\n");

const DELETED_DIFF = [
	"diff --git a/gone.txt b/gone.txt",
	"deleted file mode 100644",
	"index 1234567..0000000",
	"--- a/gone.txt",
	"+++ /dev/null",
	"@@ -1 +0,0 @@",
	"-gone file",
	"",
].join("\n");

const RENAMED_DIFF = [
	"diff --git a/old-name.ts b/new-name.ts",
	"similarity index 100%",
	"rename from old-name.ts",
	"rename to new-name.ts",
	"",
].join("\n");

const BINARY_DIFF = [
	"diff --git a/dir b/image.bin b/dir b/image.bin",
	"index 1234567..89abcde 100644",
	"Binary files a/dir b/image.bin and b/dir b/image.bin differ",
	"",
].join("\n");

const MULTI_DIFF =
	MODIFIED_DIFF + ADDED_DIFF + DELETED_DIFF + RENAMED_DIFF + BINARY_DIFF;
const DIFF_ARGS = "gh pr diff 123 --color never --repo owner/repo";

function buildDeps(
	fixtureOverrides: GhFixtureMap = {},
	options: { now?: () => number; ghHost?: string } = {},
) {
	const cacheDir = mkdtempSync(join(tmpdir(), "pi-omp-git-pr-diff-"));
	const fixtures: GhFixtureMap = {
		[DIFF_ARGS]: { stdout: MULTI_DIFF, exitCode: 0 },
		"gh --version": { stdout: "gh version 2.40.0\n", exitCode: 0 },
		"gh auth status": { exitCode: 0 },
		...fixtureOverrides,
	};
	const calls: string[] = [];
	const diffHosts: string[] = [];
	const exec: Exec = async (spec) => {
		const key = [spec.command, ...spec.args].join(" ");
		calls.push(key);
		if (
			spec.command === "gh" &&
			spec.args[0] === "pr" &&
			spec.args[1] === "diff"
		) {
			diffHosts.push(spec.env.GH_HOST ?? "");
		}
		const fixture = fixtures[key];
		if (!fixture) throw new Error(`No fixture recorded for argv: ${key}`);
		return {
			exitCode: fixture.exitCode ?? 0,
			stdout: fixture.stdout ?? "",
			stderr: fixture.stderr ?? "",
			truncated: false,
			timedOut: false,
			cancelled: false,
		};
	};
	const env: Record<string, string> = {
		PI_OMP_GITHUB_CACHE_DB: join(cacheDir, "github-cache.db"),
		GH_TOKEN: "cache-test-token",
		GH_CONFIG_DIR: join(cacheDir, "gh-config"),
		...(options.ghHost ? { GH_HOST: options.ghHost } : {}),
	};
	const cache = createGithubCache({
		getStore: () => openCacheStore(env.PI_OMP_GITHUB_CACHE_DB ?? ""),
		getSettings: () => ({
			enabled: true,
			softTtlSec: 300,
			hardTtlSec: 604800,
		}),
		authKey: () => credentialFingerprint(env),
		now: options.now,
	});
	const nativeRead = {
		execute: async () => {
			throw new Error(
				"native read must not be called for virtual GitHub resources",
			);
		},
	};
	const override = createGithubReadOverride({
		gh: createGhRunner({ exec }),
		git: createGitRunner({ exec }),
		availability: createAvailability(createRunner({ exec })),
		cache,
		env,
		getConfig: () =>
			loadConfig({
				agentDir: cacheDir,
				cwd: cacheDir,
				env,
				projectTrusted: false,
			}),
		nativeRead,
	});
	return { calls, diffHosts, fixtures, override };
}

const readVirtual = (override: GithubReadOverride, params: ReadToolParams) =>
	override.execute("test-call-id", params, undefined, undefined);

const textOf = (result: Awaited<ReturnType<typeof readVirtual>>): string =>
	result.content[0]?.type === "text" ? result.content[0].text : "";

describe("unified PR diff parsing (§15–§16)", () => {
	it("indexes modified, added, deleted, renamed, and binary files in stable order", () => {
		const diff = parseUnifiedDiff(MULTI_DIFF);
		expect(diff.files.map((file) => file.path)).toEqual([
			"é/emoji😀.ts",
			"new.txt",
			"gone.txt",
			"new-name.ts",
			"dir b/image.bin",
		]);
		expect(diff.files.map((file) => file.index)).toEqual([1, 2, 3, 4, 5]);
		expect(diff.files.map((file) => file.changeType)).toEqual([
			"modified",
			"added",
			"deleted",
			"renamed",
			"modified",
		]);
		expect(diff.files[0]).toMatchObject({
			additions: 2,
			deletions: 1,
			binary: false,
		});
		expect(diff.files[1]).toMatchObject({
			additions: 1,
			deletions: 0,
			binary: false,
		});
		expect(diff.files[2]).toMatchObject({
			additions: 0,
			deletions: 1,
			binary: false,
		});
		expect(diff.files[3]).toMatchObject({
			path: "new-name.ts",
			oldPath: "old-name.ts",
			changeType: "renamed",
		});
		expect(diff.files[4]).toMatchObject({
			path: "dir b/image.bin",
			binary: true,
		});
	});

	it("uses UTF-16 string indices so non-ASCII sections slice exactly", () => {
		const diff = parseUnifiedDiff(MULTI_DIFF);
		const first = diff.files[0];
		expect(first).toBeDefined();
		expect(diff.unifiedDiff.slice(first?.startIndex, first?.endIndex)).toBe(
			MODIFIED_DIFF,
		);
		expect(first?.startIndex).toBe(MULTI_DIFF.indexOf("diff --git"));
	});
	it("decodes Git's octal-quoted UTF-8 filenames", () => {
		const quotedDiff = [
			String.raw`diff --git "a/space\303\251.txt" "b/space\303\251.txt"`,
			String.raw`--- "a/space\303\251.txt"`,
			String.raw`+++ "b/space\303\251.txt"`,
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"",
		].join("\n");
		expect(parseUnifiedDiff(quotedDiff).files[0]?.path).toBe("spaceé.txt");
	});

	it("parses unquoted space paths and tab-delimited marker suffixes", () => {
		const spacedDiff = [
			"diff --git a/dir b/file.txt b/dir b/file.txt",
			"--- a/dir b/file.txt\t",
			"+++ b/dir b/file.txt\t",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"",
		].join("\n");
		expect(parseUnifiedDiff(spacedDiff).files[0]?.path).toBe("dir b/file.txt");
	});

	it("renders a stable 1-based changed-file index", () => {
		const text = renderPrDiff(parseUnifiedDiff(MULTI_DIFF), 123);
		expect(text).toContain("1. `é/emoji😀.ts` — modified (+2 -1)");
		expect(text).toContain("2. `new.txt` — added (+1 -0)");
		expect(text).toContain("3. `gone.txt` — deleted (+0 -1)");
		expect(text).toContain("4. `new-name.ts` — renamed from `old-name.ts`");
		expect(text).toContain("5. `dir b/image.bin` — modified (binary)");
	});
});

describe("PR diff virtual resources", () => {
	it("serves the index, one exact file section, and the verbatim full diff from one fetch", async () => {
		const { calls, override } = buildDeps();
		const index = textOf(
			await readVirtual(override, { path: "pr://owner/repo/123/diff" }),
		);
		const oneFile = textOf(
			await readVirtual(override, { path: "pr://owner/repo/123/diff/1" }),
		);
		const all = textOf(
			await readVirtual(override, { path: "pr://owner/repo/123/diff/all" }),
		);
		expect(index).toContain("1. `é/emoji😀.ts`");
		expect(oneFile).toBe(MODIFIED_DIFF);
		expect(all).toBe(MULTI_DIFF);
		expect(calls.filter((call) => call === DIFF_ARGS)).toHaveLength(1);
	});

	it("resolves explicit repository identity without local repo resolution", async () => {
		const { calls, override } = buildDeps();
		await readVirtual(override, { path: "pr://owner/repo/123/diff/all" });
		expect(calls).toContain(DIFF_ARGS);
		expect(calls.some((call) => call.startsWith("git remote"))).toBe(false);
	});

	it("passes GH_HOST through to the diff command for Enterprise", async () => {
		const { diffHosts, override } = buildDeps(
			{},
			{ ghHost: "github.example.com" },
		);
		await readVirtual(override, { path: "pr://owner/repo/123/diff/all" });
		expect(diffHosts).toEqual(["github.example.com"]);
	});

	it("keeps same-named repositories under different owners in distinct cache rows", async () => {
		const aliceArgs = "gh pr diff 123 --color never --repo alice/repo";
		const bobArgs = "gh pr diff 123 --color never --repo bob/repo";
		const { calls, override } = buildDeps({
			[aliceArgs]: { stdout: MODIFIED_DIFF, exitCode: 0 },
			[bobArgs]: { stdout: ADDED_DIFF, exitCode: 0 },
		});
		const alice = textOf(
			await readVirtual(override, { path: "pr://alice/repo/123/diff/all" }),
		);
		const bob = textOf(
			await readVirtual(override, { path: "pr://bob/repo/123/diff/all" }),
		);
		expect(alice).toBe(MODIFIED_DIFF);
		expect(bob).toBe(ADDED_DIFF);
		expect(calls.filter((call) => call.startsWith("gh pr diff "))).toHaveLength(
			2,
		);
	});

	it("resolves a bare diff resource from the current GitHub checkout", async () => {
		const { calls, override } = buildDeps({
			"git remote get-url origin": {
				stdout: "https://github.com/owner/repo\n",
				exitCode: 0,
			},
		});
		await readVirtual(override, { path: "pr://123/diff/all" });
		expect(calls).toContain("git remote get-url origin");
		expect(calls).toContain(DIFF_ARGS);
	});

	it("honors pagination caps, continuation notices, and out-of-range errors", async () => {
		const longBody = Array.from(
			{ length: 2100 },
			(_, index) => `+line ${index + 1}`,
		);
		const longDiff = [
			"diff --git a/large.txt b/large.txt",
			"--- a/large.txt",
			"+++ b/large.txt",
			"@@ -0,0 +1,2100 @@",
			...longBody,
			"",
		].join("\n");
		const { override } = buildDeps({
			[DIFF_ARGS]: { stdout: longDiff, exitCode: 0 },
		});
		const index = textOf(
			await readVirtual(override, {
				path: "pr://owner/repo/123/diff",
				limit: 1,
			}),
		);
		expect(index).toContain("more lines in file");

		const full = textOf(
			await readVirtual(override, { path: "pr://owner/repo/123/diff/all" }),
		);
		expect(full).toContain("[Showing lines 1-2000 of");
		expect(full).toContain("Use offset=2001 to continue.");

		const file = textOf(
			await readVirtual(override, {
				path: "pr://owner/repo/123/diff/1",
				offset: 2001,
				limit: 100,
			}),
		);
		expect(file).toContain("line 1999");
		expect(file).toContain("more lines in file");
		await expect(
			readVirtual(override, {
				path: "pr://owner/repo/123/diff/all",
				offset: 999_999,
			}),
		).rejects.toThrow(/^Offset 999999 is beyond end of file/);
		await expect(
			readVirtual(override, { path: "pr://owner/repo/123/diff/2" }),
		).rejects.toThrow(/file index 2 is out of range/);
	});

	it.each([
		"pr://owner/repo/123/diff",
		"pr://owner/repo/123/diff/1",
		"pr://owner/repo/123/diff/all",
	])("warns when %s paginates a newer cached row", async (path) => {
		let now = 0;
		const { fixtures, override } = buildDeps(
			{ [DIFF_ARGS]: { stdout: MODIFIED_DIFF, exitCode: 0 } },
			{ now: () => now },
		);
		await readVirtual(override, { path });
		fixtures[DIFF_ARGS] = {
			stdout: MODIFIED_DIFF.replace("old value", "changed value"),
			exitCode: 0,
		};
		now = 604_800_001;
		const page = textOf(
			await readVirtual(override, { path, offset: 1, limit: 1 }),
		);
		expect(page.startsWith(PR_DIFF_UPDATED_NOTICE)).toBe(true);
	});
	it("does not advance the served version after an out-of-range page", async () => {
		let now = 0;
		const path = "pr://owner/repo/123/diff/all";
		const { fixtures, override } = buildDeps(
			{ [DIFF_ARGS]: { stdout: MODIFIED_DIFF, exitCode: 0 } },
			{ now: () => now },
		);
		await readVirtual(override, { path });
		fixtures[DIFF_ARGS] = {
			stdout: MODIFIED_DIFF.replace("old value", "changed value"),
			exitCode: 0,
		};
		now = 604_800_001;
		await expect(
			readVirtual(override, { path, offset: 999_999 }),
		).rejects.toThrow(/^Offset 999999 is beyond end of file/);
		const page = textOf(
			await readVirtual(override, { path, offset: 1, limit: 1 }),
		);
		expect(page.startsWith(PR_DIFF_UPDATED_NOTICE)).toBe(true);
	});
});
