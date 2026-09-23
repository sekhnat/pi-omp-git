/**
 * Ticket 04 acceptance tests: `read pr://N` single-resource rendering —
 * the complete PR (metadata, body, files preview, reviews, line-level
 * review comments with thread relationships, conversation comments),
 * the 100-per-page review-comment collection, rendering when a PR has
 * review comments but zero conversation comments, `?comments=0|false`
 * suppression, minimized-comment exclusion, and the comments flag as
 * part of the cache identity (docs/pi-omp-git-reference.md §12–§14).
 *
 * External behavior only: GitHub I/O flows through the scripted `gh`
 * fixture seam; the cache is a real SQLite database on a temporary path.
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
	PR_FIELDS,
	PR_FIELDS_LEGACY,
	PR_FIELDS_LEGACY_NO_COMMENTS,
	PR_FIELDS_NO_COMMENTS,
} from "../src/github/resources/prs.ts";
import {
	createGithubReadOverride,
	type GithubReadOverride,
	type ReadToolParams,
} from "../src/github/resources/router.ts";
import { createGhRunner, type GhFixtureMap } from "../src/github/runner.ts";
import { loadConfig } from "../src/shared/config.ts";
import { createRunner, type Exec } from "../src/shared/subprocess.ts";

const PR_PAYLOAD = {
	number: 123,
	title: "Add streaming ingest",
	state: "OPEN",
	isDraft: false,
	author: { login: "alice" },
	baseRefName: "main",
	headRefName: "feature/streaming",
	reviewDecision: "APPROVED",
	mergeStateStatus: "CLEAN",
	body: "Implements the ingest pipeline.\n\nFixes #99.",
	labels: [{ name: "enhancement" }],
	createdAt: "2026-01-01T10:00:00Z",
	updatedAt: "2026-01-03T09:00:00Z",
	url: "https://github.com/owner/repo/pull/123",
	files: [
		{
			path: "src/app.ts",
			additions: 10,
			deletions: 2,
			changeType: "MODIFIED",
		},
		{
			path: "src/stream.ts",
			additions: 40,
			deletions: 0,
			changeType: "ADDED",
		},
	],
	reviews: [
		{
			author: { login: "bob" },
			state: "APPROVED",
			body: "Looks great.",
			submittedAt: "2026-01-02T12:00:00Z",
			url: "https://github.com/owner/repo/pull/123#pullrequestreview-1",
		},
		{
			author: { login: "carol" },
			state: "CHANGES_REQUESTED",
			body: "One nit below.",
			submittedAt: "2026-01-02T13:00:00Z",
			url: "https://github.com/owner/repo/pull/123#pullrequestreview-2",
		},
	],
	comments: [
		{
			author: { login: "bob" },
			body: "Ship it when green.",
			createdAt: "2026-01-02T14:00:00Z",
			isMinimized: false,
		},
		{
			author: { login: "spammer" },
			body: "buy followers",
			createdAt: "2026-01-02T15:00:00Z",
			isMinimized: true,
		},
	],
};

/** REST shape for line-level review comments (§13). */
const REVIEW_COMMENTS = [
	{
		id: 1001,
		user: { login: "bob" },
		body: "This loop never terminates.",
		created_at: "2026-01-02T12:30:00Z",
		path: "src/app.ts",
		line: 42,
		original_line: 42,
		side: "RIGHT",
		html_url: "https://github.com/owner/repo/pull/123#discussion_r1001",
	},
	{
		id: 1002,
		user: { login: "alice" },
		body: "Fixed in the next push.",
		created_at: "2026-01-02T12:35:00Z",
		in_reply_to_id: 1001,
		path: "src/app.ts",
		line: 42,
		side: "RIGHT",
		html_url: "https://github.com/owner/repo/pull/123#discussion_r1002",
	},
];

const prPayloadJson = (overrides: Record<string, unknown> = {}): string =>
	JSON.stringify({ ...PR_PAYLOAD, ...overrides });

const REVIEW_COMMENTS_ARGS =
	"gh api repos/owner/repo/pulls/123/comments?per_page=100 --paginate --slurp";

function baseFixtures(): GhFixtureMap {
	return {
		[`gh pr view 123 -R owner/repo --json ${PR_FIELDS}`]: {
			stdout: prPayloadJson(),
			exitCode: 0,
		},
		[`gh pr view 123 -R owner/repo --json ${PR_FIELDS_NO_COMMENTS}`]: {
			stdout: prPayloadJson({ reviews: undefined, comments: undefined }),
			exitCode: 0,
		},
		[REVIEW_COMMENTS_ARGS]: {
			stdout: JSON.stringify(REVIEW_COMMENTS),
			exitCode: 0,
		},
		"git remote get-url origin": {
			stdout: "https://github.com/owner/repo\n",
			exitCode: 0,
		},
		"gh --version": { stdout: "gh version 2.40.0\n", exitCode: 0 },
		"gh auth status": { exitCode: 0 },
	};
}

interface CapturedCall {
	command: string;
	args: string[];
}

interface BuildDepsOptions {
	cacheEnabled?: boolean;
	softTtlSec?: number;
	now?: () => number;
}

function buildDeps(
	fixtureOverrides: GhFixtureMap = {},
	options: BuildDepsOptions = {},
) {
	const fixtures = { ...baseFixtures(), ...fixtureOverrides };
	const calls: CapturedCall[] = [];
	const exec: Exec = async (spec) => {
		calls.push({ command: spec.command, args: [...spec.args] });
		const key = [spec.command, ...spec.args].join(" ");
		const fixture = fixtures[key];
		if (!fixture) {
			throw new Error(`No fixture recorded for argv: ${key}`);
		}
		return {
			exitCode: fixture.exitCode ?? 0,
			stdout: fixture.stdout ?? "",
			stderr: fixture.stderr ?? "",
			truncated: false,
			timedOut: false,
			cancelled: false,
		};
	};
	const runner = createRunner({ exec });
	const availability = createAvailability(runner);
	const nativeRead = {
		execute: async () => {
			throw new Error(
				"native read must not be called for virtual GitHub resources",
			);
		},
	};
	const cacheDir = mkdtempSync(join(tmpdir(), "pi-omp-git-cache-"));
	const dbPath = join(cacheDir, "github-cache.db");
	const env: Record<string, string> = {
		PI_OMP_GITHUB_CACHE_DB: dbPath,
		GH_TOKEN: "cache-test-token",
		GH_CONFIG_DIR: join(cacheDir, "gh-config"),
	};
	const cache = createGithubCache({
		getStore: () => openCacheStore(dbPath),
		getSettings: () => ({
			enabled: options.cacheEnabled ?? true,
			softTtlSec: options.softTtlSec ?? 300,
			hardTtlSec: 604800,
		}),
		authKey: () => credentialFingerprint(env),
		now: options.now,
	});
	const override = createGithubReadOverride({
		gh: createGhRunner({ exec }),
		git: createGitRunner({ exec }),
		availability,
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
	return { override, calls, fixtures };
}

const readVirtual = (override: GithubReadOverride, params: ReadToolParams) =>
	override.execute("test-call-id", params, undefined, undefined);

const textOf = (result: Awaited<ReturnType<typeof readVirtual>>): string =>
	result.content[0]?.type === "text" ? result.content[0].text : "";

const viewCallCount = (calls: CapturedCall[]): number =>
	calls.filter(
		(candidate) =>
			candidate.command === "gh" && candidate.args.includes("view"),
	).length;

const apiCallCount = (calls: CapturedCall[]): number =>
	calls.filter(
		(candidate) => candidate.command === "gh" && candidate.args.includes("api"),
	).length;

describe("read pr://N rendering", () => {
	it("renders all required sections from the PR representation", async () => {
		const { override } = buildDeps();
		const result = await readVirtual(override, { path: "pr://123" });
		const text = textOf(result);
		expect(text).toContain("# 123 Add streaming ingest");
		expect(text).toContain("Draft: no");
		expect(text).toContain("State: OPEN");
		expect(text).toContain("Author: alice");
		expect(text).toContain("Base: main");
		expect(text).toContain("Head: feature/streaming");
		expect(text).toContain("Review decision: APPROVED");
		expect(text).toContain("Merge state: CLEAN");
		expect(text).toContain("Created: 2026-01-01T10:00:00Z");
		expect(text).toContain("Updated: 2026-01-03T09:00:00Z");
		expect(text).toContain("Labels: enhancement");
		expect(text).toContain("URL: https://github.com/owner/repo/pull/123");
		expect(text).toContain("## Body");
		expect(text).toContain("Fixes #99.");
		expect(text).toContain("## Files");
		expect(text).toContain("- src/app.ts (+10 -2)");
		expect(text).toContain("- src/stream.ts (+40 -0)");
		expect(text).toContain("## Reviews");
		expect(text).toContain("### APPROVED — bob on 2026-01-02T12:00:00Z");
		expect(text).toContain("Looks great.");
		expect(text).toContain("## Review Comments");
		expect(text).toContain("## Comments");
		expect(text).toContain("### bob on 2026-01-02T14:00:00Z");
		// Minimized conversation comments are excluded (§11).
		expect(text).not.toContain("buy followers");
	});

	it("renders the files preview capped at 50 with an overflow note", async () => {
		const files = Array.from({ length: 55 }, (_, index) => ({
			path: `src/file-${index + 1}.ts`,
			additions: 1,
			deletions: 0,
		}));
		const { override } = buildDeps({
			[`gh pr view 123 -R owner/repo --json ${PR_FIELDS}`]: {
				stdout: prPayloadJson({ files }),
				exitCode: 0,
			},
		});
		const text = textOf(await readVirtual(override, { path: "pr://123" }));
		expect(text).toContain("- src/file-50.ts");
		expect(text).not.toContain("- src/file-51.ts");
		expect(text).toContain("more files");
	});

	it("renders review comments with thread relationships (§13)", async () => {
		const { override } = buildDeps();
		const text = textOf(await readVirtual(override, { path: "pr://123" }));
		expect(text).toContain("### bob on src/app.ts:42, 2026-01-02T12:30:00Z");
		expect(text).toContain("This loop never terminates.");
		// The reply keeps its parent relationship visible.
		expect(text).toContain("↳ (reply to bob)");
		expect(text).toContain("Fixed in the next push.");
	});

	it("renders the review sections when there are zero conversation comments", async () => {
		const { override } = buildDeps({
			[`gh pr view 123 -R owner/repo --json ${PR_FIELDS}`]: {
				stdout: prPayloadJson({ comments: [] }),
				exitCode: 0,
			},
		});
		const text = textOf(await readVirtual(override, { path: "pr://123" }));
		expect(text).toContain("## Reviews");
		expect(text).toContain("## Review Comments");
		expect(text).not.toContain("## Comments");
	});

	it("collects review comments separately at 100 per page", async () => {
		const { override, calls } = buildDeps();
		await readVirtual(override, { path: "pr://owner/repo/123" });
		const apiCalls = calls.filter(
			(candidate) => candidate.command === "gh" && candidate.args[0] === "api",
		);
		expect(apiCalls).toHaveLength(1);
		expect(apiCalls[0]?.args).toEqual([
			"api",
			"repos/owner/repo/pulls/123/comments?per_page=100",
			"--paginate",
			"--slurp",
		]);
		// The metadata/comments view call happens exactly once.
		expect(viewCallCount(calls)).toBe(1);
	});
});

describe("read pr://N comment suppression", () => {
	it.each(["0", "false"])(
		"?comments=%s omits discussion material but keeps metadata and files",
		async (value) => {
			const { override, calls } = buildDeps();
			const text = textOf(
				await readVirtual(override, { path: `pr://123?comments=${value}` }),
			);
			expect(text).toContain("# 123 Add streaming ingest");
			expect(text).toContain("State: OPEN");
			expect(text).toContain("Review decision: APPROVED");
			expect(text).toContain("## Files");
			expect(text).toContain("- src/app.ts");
			expect(text).not.toContain("## Reviews");
			expect(text).not.toContain("## Review Comments");
			expect(text).not.toContain("## Comments");
			expect(text).not.toContain("Looks great.");
			// Suppression avoids the expensive calls entirely (§14): the
			// review-comments REST call never runs, and the view call omits
			// the discussion fields.
			expect(apiCallCount(calls)).toBe(0);
			const view = calls.find(
				(candidate) =>
					candidate.command === "gh" && candidate.args.includes("view"),
			);
			expect([view?.command, ...(view?.args ?? [])].join(" ")).toBe(
				`gh pr view 123 -R owner/repo --json ${PR_FIELDS_NO_COMMENTS}`,
			);
		},
	);

	it("treats the comments flag as part of the cache identity", async () => {
		const { override, calls } = buildDeps();
		await readVirtual(override, { path: "pr://123" });
		await readVirtual(override, { path: "pr://123?comments=0" });
		// Flipping the flag produced a distinct cache row: a second view
		// call (with the reduced fields) and no shared hit.
		expect(viewCallCount(calls)).toBe(2);
		const viewCalls = calls.filter(
			(candidate) =>
				candidate.command === "gh" && candidate.args.includes("view"),
		);
		expect(viewCalls).toHaveLength(2);
		expect(
			[viewCalls[1]?.command, ...(viewCalls[1]?.args ?? [])].join(" "),
		).toBe(`gh pr view 123 -R owner/repo --json ${PR_FIELDS_NO_COMMENTS}`);

		// A repeat of each variant is served from its own row.
		const viewCallsBefore = viewCallCount(calls);
		await readVirtual(override, { path: "pr://123" });
		await readVirtual(override, { path: "pr://123?comments=false" });
		expect(viewCallCount(calls)).toBe(viewCallsBefore);
	});

	it("caches repeated full reads without a second gh invocation", async () => {
		const { override, calls } = buildDeps();
		await readVirtual(override, { path: "pr://123" });
		await readVirtual(override, { path: "pr://123" });
		expect(viewCallCount(calls)).toBe(1);
		expect(apiCallCount(calls)).toBe(1);
	});

	it("keeps suppression on the legacy retry path (§11 + §14)", async () => {
		const { override, calls } = buildDeps({
			[`gh pr view 123 -R owner/repo --json ${PR_FIELDS_NO_COMMENTS}`]: {
				exitCode: 1,
				stderr: 'Unknown JSON field: "mergeStateStatus"',
			},
			[`gh pr view 123 -R owner/repo --json ${PR_FIELDS_LEGACY_NO_COMMENTS}`]: {
				stdout: prPayloadJson({
					mergeStateStatus: undefined,
					reviews: undefined,
					comments: undefined,
				}),
				exitCode: 0,
			},
		});
		const text = textOf(
			await readVirtual(override, { path: "pr://123?comments=0" }),
		);
		// The §11 fallback still carries no discussion material (§14)…
		const viewCalls = calls.filter(
			(candidate) =>
				candidate.command === "gh" && candidate.args.includes("view"),
		);
		expect(viewCalls).toHaveLength(2);
		expect(
			[viewCalls[1]?.command, ...(viewCalls[1]?.args ?? [])].join(" "),
		).toBe(
			`gh pr view 123 -R owner/repo --json ${PR_FIELDS_LEGACY_NO_COMMENTS}`,
		);
		expect(apiCallCount(calls)).toBe(0);
		// …and the rendered text stays suppressed.
		expect(text).toContain("## Files");
		expect(text).not.toContain("## Reviews");
		expect(text).not.toContain("## Comments");
	});
});

describe("read pr://N error surfaces", () => {
	it("retries with the unsupported field omitted for older gh (§11)", async () => {
		const { override } = buildDeps({
			[`gh pr view 123 -R owner/repo --json ${PR_FIELDS}`]: {
				exitCode: 1,
				stderr: 'Unknown JSON field: "mergeStateStatus"',
			},
			[`gh pr view 123 -R owner/repo --json ${PR_FIELDS_LEGACY}`]: {
				stdout: prPayloadJson({ mergeStateStatus: undefined }),
				exitCode: 0,
			},
		});
		const text = textOf(await readVirtual(override, { path: "pr://123" }));
		expect(text).toContain("Review decision: APPROVED");
		expect(text).not.toContain("Merge state:");
		// Review comments are still collected after the retry (§13).
		// Review comments are still collected after the retry (§13).
		expect(text).toContain("This loop never terminates.");
	});

	it("maps a missing PR to the friendly not-found error", async () => {
		const { override } = buildDeps({
			[`gh pr view 123 -R owner/repo --json ${PR_FIELDS}`]: {
				exitCode: 1,
				stderr: "could not resolve to a Pull Request with the number 123",
			},
		});
		await expect(readVirtual(override, { path: "pr://123" })).rejects.toThrow(
			/pull request #123 was not found in owner\/repo/i,
		);
	});
});
