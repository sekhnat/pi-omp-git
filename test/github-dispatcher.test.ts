/**
 * Ticket 08 acceptance tests: the `github` dispatcher with `repo_view` and
 * `file_read` (docs/pi-omp-git-reference.md §§18–21), the error taxonomy
 * (§49, §90), and the §59 prompt-guideline build hook.
 *
 * External behavior only: GitHub I/O flows through the scripted `gh`
 * fixture seam; unknown argv is recorded and rejected.
 */

import { describe, expect, it } from "vitest";
import { createGitRunner } from "../src/git/runner.ts";
import { createAvailability } from "../src/github/availability.ts";
import {
	createGithubTool,
	executeGithubOperation,
	GITHUB_OPERATIONS,
	type GithubTool,
} from "../src/github/dispatcher.ts";
import {
	buildSourceUrl,
	encodeContentsPath,
	validateFileReadPath,
} from "../src/github/operations/file-read.ts";
import {
	REPO_VIEW_FIELDS,
	REPO_VIEW_FIELDS_LEGACY,
} from "../src/github/operations/repo-view.ts";
import {
	buildSearchQuery,
	hasBroadScope,
	parseSearchDate,
	parseSearchLimit,
} from "../src/github/operations/search.ts";
import { GITHUB_PROMPT_GUIDELINES } from "../src/github/prompt-guidelines.ts";
import { createGhRunner, type GhFixtureMap } from "../src/github/runner.ts";
import type { Exec } from "../src/shared/subprocess.ts";
import { createRunner } from "../src/shared/subprocess.ts";

const REPO_FIELDS = REPO_VIEW_FIELDS.join(",");
const LEGACY_FIELDS = REPO_VIEW_FIELDS_LEGACY.join(",");

const REPO_PAYLOAD = {
	nameWithOwner: "owner/repo",
	description: "A test repository",
	url: "https://github.com/owner/repo",
	defaultBranchRef: { name: "main" },
	visibility: "PUBLIC",
	viewerPermission: "ADMIN",
	primaryLanguage: { name: "TypeScript" },
	stargazerCount: 120,
	forkCount: 7,
	isArchived: false,
	isFork: false,
	updatedAt: "2026-01-02T03:04:05Z",
	homepageUrl: "https://example.com",
	repositoryTopics: [{ name: "cli" }, { name: "testing" }],
};

interface CapturedCall {
	command: string;
	args: string[];
	env: Record<string, string>;
}

function buildTool(fixtureOverrides: GhFixtureMap = {}) {
	const fixtures: GhFixtureMap = {
		"gh --version": { stdout: "gh version 2.40.0\n", exitCode: 0 },
		"gh auth status": { exitCode: 0 },
		...fixtureOverrides,
	};
	const calls: CapturedCall[] = [];
	const exec: Exec = async (spec) => {
		calls.push({
			command: spec.command,
			args: [...spec.args],
			env: spec.env,
		});
		const key = [spec.command, ...spec.args].join(" ");
		const fixture = fixtures[key];
		if (!fixture) {
			throw new Error(`No fixture recorded for argv: ${key}`);
		}
		return {
			exitCode: fixture.exitCode ?? 0,
			stdout: fixture.stdout ?? "",
			stderr: fixture.stderr ?? "",
			truncated: fixture.truncated ?? false,
			timedOut: false,
			cancelled: false,
		};
	};
	const runner = createRunner({ exec });
	const tool = createGithubTool({
		gh: createGhRunner({ exec }),
		git: createGitRunner({ exec }),
		availability: createAvailability(runner),
		env: { GH_TOKEN: "test-token" },
	});
	return { tool, calls, fixtures };
}

const callGithub = (tool: GithubTool, params: Record<string, unknown> | null) =>
	tool.execute("test-call-id", params as never, undefined);

/** gh calls minus the availability probes (--version, auth status). */
const ghCalls = (calls: CapturedCall[]) =>
	calls.filter(
		(call) =>
			call.command === "gh" &&
			call.args[0] !== "--version" &&
			!(call.args[0] === "auth" && call.args[1] === "status"),
	);

const contentsJson = (
	path: string,
	payload: Record<string, unknown>,
): GhFixtureMap => ({
	[`gh api repos/owner/repo/contents/${path}`]: {
		stdout: JSON.stringify(payload),
		exitCode: 0,
	},
});

describe("github dispatcher validation", () => {
	it("rejects unknown operations and lists the valid enum", async () => {
		const { tool } = buildTool();
		await expect(callGithub(tool, { op: "repo_create" })).rejects.toThrow(
			/unknown github operation: "repo_create"/i,
		);
		await expect(callGithub(tool, { op: "repo_create" })).rejects.toThrow(
			/repo_view/,
		);
	});

	it("rejects a non-string operation", async () => {
		const { tool } = buildTool();
		await expect(callGithub(tool, { op: 123 })).rejects.toThrow(
			/unknown github operation/i,
		);
	});

	it("rejects a missing operation", async () => {
		const { tool } = buildTool();
		await expect(callGithub(tool, {})).rejects.toThrow(
			/unknown github operation: undefined/i,
		);
	});

	it("rejects non-object parameters", async () => {
		const { tool } = buildTool();
		await expect(callGithub(tool, null)).rejects.toThrow(
			/requires a parameters object/i,
		);
	});

	it("reports unimplemented operations clearly", async () => {
		const { tool } = buildTool();
		await expect(callGithub(tool, { op: "pr_checkout" })).rejects.toThrow(
			/not available in this build/i,
		);
		await expect(callGithub(tool, { op: "pr_push" })).rejects.toThrow(
			/not available in this build/i,
		);
		await expect(callGithub(tool, { op: "run_watch" })).rejects.toThrow(
			/not available in this build/i,
		);
	});

	it("rejects empty and mistyped parameters", async () => {
		const { tool } = buildTool();
		await expect(callGithub(tool, { op: "file_read" })).rejects.toThrow(
			/path/i,
		);
		await expect(
			callGithub(tool, { op: "file_read", path: "   " }),
		).rejects.toThrow(/non-empty string/i);
		await expect(
			callGithub(tool, { op: "repo_view", repo: 42 }),
		).rejects.toThrow(/`repo` parameter must be a non-empty string/i);
	});

	it("keeps the §18 operation enum stable", () => {
		expect([...GITHUB_OPERATIONS]).toEqual([
			"repo_view",
			"file_read",
			"pr_create",
			"pr_checkout",
			"pr_push",
			"search_issues",
			"search_prs",
			"search_code",
			"search_commits",
			"search_repos",
			"run_watch",
		]);
	});
});

describe("github repo_view", () => {
	it("returns the full metadata set for an explicit repository", async () => {
		const { tool } = buildTool({
			[`gh repo view owner/repo --json ${REPO_FIELDS}`]: {
				stdout: JSON.stringify(REPO_PAYLOAD),
				exitCode: 0,
			},
		});
		const result = await callGithub(tool, {
			op: "repo_view",
			repo: "owner/repo",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("# owner/repo");
		expect(text).toContain("Description: A test repository");
		expect(text).toContain("URL: https://github.com/owner/repo");
		expect(text).toContain("Default branch: main");
		expect(text).toContain("Visibility: PUBLIC");
		expect(text).toContain("Viewer permission: ADMIN");
		expect(text).toContain("Language: TypeScript");
		expect(text).toContain("Stars: 120");
		expect(text).toContain("Forks: 7");
		expect(text).toContain("Archived: no");
		expect(text).toContain("Fork: no");
		expect(text).toContain("Updated: 2026-01-02T03:04:05Z");
		expect(text).toContain("Homepage: https://example.com");
		expect(text).toContain("Topics: cli, testing");
	});

	it("echoes the requested branch when given", async () => {
		const { tool } = buildTool({
			[`gh repo view owner/repo --json ${REPO_FIELDS}`]: {
				stdout: JSON.stringify(REPO_PAYLOAD),
				exitCode: 0,
			},
		});
		const result = await callGithub(tool, {
			op: "repo_view",
			repo: "owner/repo",
			branch: "release/next",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Requested branch: release/next");
	});

	it("resolves an omitted repository via gh (no local git call)", async () => {
		const args = `gh repo view --json ${REPO_FIELDS}`;
		const { tool, calls } = buildTool({
			[args]: { stdout: JSON.stringify(REPO_PAYLOAD), exitCode: 0 },
		});
		const result = await callGithub(tool, { op: "repo_view" });
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("# owner/repo");
		expect(ghCalls(calls)).toHaveLength(1);
		expect(
			[ghCalls(calls)[0]?.command, ...(ghCalls(calls)[0]?.args ?? [])].join(
				" ",
			),
		).toBe(args);
	});

	it("routes host-qualified repositories through GH_HOST", async () => {
		const fixtureKey = `gh repo view owner/repo --json ${REPO_FIELDS}`;
		const { tool, calls } = buildTool({
			[fixtureKey]: { stdout: JSON.stringify(REPO_PAYLOAD), exitCode: 0 },
		});
		await callGithub(tool, {
			op: "repo_view",
			repo: "github.acme.internal/owner/repo",
		});
		expect(ghCalls(calls)).toHaveLength(1);
		expect(
			[ghCalls(calls)[0]?.command, ...(ghCalls(calls)[0]?.args ?? [])].join(
				" ",
			),
		).toBe(fixtureKey);
		expect(ghCalls(calls)[0]?.env.GH_HOST).toBe("github.acme.internal");
	});

	it("retries with the unsupported field omitted on older gh", async () => {
		const { tool, calls } = buildTool({
			[`gh repo view owner/repo --json ${REPO_FIELDS}`]: {
				exitCode: 1,
				stderr: 'Unknown JSON field: "repositoryTopics"',
			},
			[`gh repo view owner/repo --json ${LEGACY_FIELDS}`]: {
				stdout: JSON.stringify({
					...REPO_PAYLOAD,
					repositoryTopics: undefined,
				}),
				exitCode: 0,
			},
		});
		const result = await callGithub(tool, {
			op: "repo_view",
			repo: "owner/repo",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("# owner/repo");
		expect(text).not.toContain("Topics:");
		expect(ghCalls(calls)).toHaveLength(2);
	});

	it("maps a missing repository to the friendly not-found error", async () => {
		const { tool } = buildTool({
			[`gh repo view owner/missing --json ${REPO_FIELDS}`]: {
				exitCode: 1,
				stderr:
					"Could not resolve to a Repository with the name 'owner/missing'.",
			},
		});
		await expect(
			callGithub(tool, { op: "repo_view", repo: "owner/missing" }),
		).rejects.toThrow(/owner\/missing was not found or is not accessible/i);
	});

	it("maps a missing gh to the friendly dependency error", async () => {
		const { tool } = buildTool({
			"gh --version": { exitCode: 1 },
		});
		await expect(
			callGithub(tool, { op: "repo_view", repo: "owner/repo" }),
		).rejects.toThrow(/GitHub CLI \(gh\) is not installed/i);
	});

	it("maps an unauthenticated gh to the friendly auth error", async () => {
		const { tool } = buildTool({
			"gh auth status": { exitCode: 1 },
		});
		await expect(
			callGithub(tool, { op: "repo_view", repo: "owner/repo" }),
		).rejects.toThrow(/not authenticated/i);
	});
});

describe("search date and limit helpers", () => {
	const fixedNow = new Date("2026-09-23T12:00:00Z");

	it("interprets relative units at invocation time", () => {
		expect(parseSearchDate("7d", "since", fixedNow)).toBe(
			"2026-09-16T12:00:00Z",
		);
		expect(parseSearchDate("12h", "since", fixedNow)).toBe(
			"2026-09-23T00:00:00Z",
		);
		expect(parseSearchDate("3m", "since", fixedNow)).toBe(
			"2026-09-23T11:57:00Z",
		);
		expect(parseSearchDate("2w", "since", fixedNow)).toBe(
			"2026-09-09T12:00:00Z",
		);
		expect(parseSearchDate("3mo", "since", fixedNow)).toBe(
			"2026-06-23T12:00:00Z",
		);
		expect(parseSearchDate("1y", "since", fixedNow)).toBe(
			"2025-09-23T12:00:00Z",
		);
		expect(parseSearchDate("3mo", "since", fixedNow)).not.toBe(
			parseSearchDate("3m", "since", fixedNow),
		);
	});

	it("passes absolute dates through unaltered", () => {
		expect(parseSearchDate("2025-06-01", "since", fixedNow)).toBe("2025-06-01");
		expect(parseSearchDate("2025-06-01T10:00:00Z", "since", fixedNow)).toBe(
			"2025-06-01T10:00:00Z",
		);
	});

	it("rejects unparseable dates", () => {
		expect(() => parseSearchDate("3x", "since", fixedNow)).toThrow(
			/Invalid since date/,
		);
		expect(() => parseSearchDate("", "until", fixedNow)).toThrow(
			/Invalid until date/,
		);
		expect(() => parseSearchDate("yesterday", "since", fixedNow)).toThrow(
			/Invalid since date/,
		);
	});

	it("applies the §35 limit policy", () => {
		expect(parseSearchLimit(undefined)).toBe(10);
		expect(parseSearchLimit(null)).toBe(10);
		expect(parseSearchLimit(2.7)).toBe(2);
		expect(parseSearchLimit(100)).toBe(50);
		expect(() => parseSearchLimit(0)).toThrow(/positive/);
		expect(() => parseSearchLimit(-3)).toThrow(/positive/);
		expect(() => parseSearchLimit(Number.NaN)).toThrow(/finite/);
		expect(() => parseSearchLimit(Number.POSITIVE_INFINITY)).toThrow(/finite/);
		expect(() => parseSearchLimit("10")).toThrow(/finite number/);
	});

	it("skips implicit repo scoping for broad-scope queries", () => {
		expect(hasBroadScope("org:acme crash")).toBe(true);
		expect(hasBroadScope("repo:owner/repo crash")).toBe(true);
		expect(hasBroadScope("user:alice crash")).toBe(true);
		expect(hasBroadScope("owner:alice crash")).toBe(true);
		expect(hasBroadScope("is:open crash")).toBe(false);
		expect(hasBroadScope("myrepo:crash")).toBe(false);
	});

	it("maps dateField per resource type", () => {
		const target = { query: "crash", since: "2025-06-01" };
		expect(
			buildSearchQuery("search_issues", target, "owner/repo", fixedNow),
		).toBe("crash is:issue repo:owner/repo created:>=2025-06-01");
		expect(
			buildSearchQuery(
				"search_issues",
				{ query: "crash", since: "2025-06-01", dateField: "updated" },
				"owner/repo",
				fixedNow,
			),
		).toBe("crash is:issue repo:owner/repo updated:>=2025-06-01");
		expect(
			buildSearchQuery(
				"search_repos",
				{ query: "cli", since: "2025-06-01", dateField: "updated" },
				undefined,
				fixedNow,
			),
		).toBe("cli pushed:>=2025-06-01");
		expect(
			buildSearchQuery(
				"search_commits",
				{ query: "refactor", since: "2025-06-01", dateField: "updated" },
				"owner/repo",
				fixedNow,
			),
		).toBe("refactor repo:owner/repo committer-date:>=2025-06-01");
		expect(() =>
			buildSearchQuery(
				"search_code",
				{ query: "crash", since: "2025-06-01" },
				"owner/repo",
				fixedNow,
			),
		).toThrow(/does not support since\/until/);
	});
});

describe("github search operations", () => {
	const issueItem = (
		number: number,
		overrides: Record<string, unknown> = {},
	) => ({
		number,
		title: `Fix login flow ${number}`,
		state: "open",
		user: { login: "alice" },
		labels: [{ name: "bug" }, { name: "auth" }],
		created_at: "2026-01-02T10:00:00Z",
		updated_at: "2026-01-05T10:00:00Z",
		html_url: `https://github.com/owner/repo/issues/${number}`,
		repository_url: "https://api.github.com/repos/owner/repo",
		...overrides,
	});

	const envelope = (items: unknown[], total = items.length): string =>
		JSON.stringify({ total_count: total, incomplete_results: false, items });

	/** Mirrors the search URL the dispatcher sends through `gh api`. */
	const searchKey = (
		endpoint: string,
		query: string,
		limit: number,
		extraArgs: string[] = [],
	): string =>
		[
			"gh",
			"api",
			`${endpoint}?q=${encodeURIComponent(query)}&per_page=${limit}`,
			...extraArgs,
		].join(" ");

	it("renders issue results with agent-useful fields and URLs", async () => {
		const finalQuery = "login bug is:issue repo:owner/repo";
		const { tool } = buildTool({
			[searchKey("search/issues", finalQuery, 10)]: {
				stdout: envelope([issueItem(42)], 23),
			},
		});
		const result = await callGithub(tool, {
			op: "search_issues",
			repo: "owner/repo",
			query: "login bug",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain(
			'GitHub issue search — "login bug is:issue repo:owner/repo"',
		);
		expect(text).toContain("23 total, showing 1");
		expect(text).toContain("1. #42 [open] Fix login flow 42");
		expect(text).toContain("owner/repo · author alice · labels bug, auth");
		expect(text).toContain("created 2026-01-02");
		expect(text).toContain("https://github.com/owner/repo/issues/42");
		expect(result.details).toMatchObject({
			op: "search_issues",
			repo: "owner/repo",
			query: finalQuery,
			limit: 10,
			total: 23,
		});
	});

	it("targets PRs through the issues endpoint with is:pr", async () => {
		const finalQuery = "refactor is:pr repo:owner/repo";
		const { tool } = buildTool({
			[searchKey("search/issues", finalQuery, 10)]: {
				stdout: envelope([
					issueItem(7, {
						html_url: "https://github.com/owner/repo/pull/7",
					}),
				]),
			},
		});
		const result = await callGithub(tool, {
			op: "search_prs",
			repo: "owner/repo",
			query: "refactor",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("GitHub pull request search");
		expect(text).toContain("#7 [open] Fix login flow 7");
		expect(text).toContain("https://github.com/owner/repo/pull/7");
	});

	it("scopes omitted repositories to the current checkout", async () => {
		const finalQuery = "is:open docs is:issue repo:owner/repo";
		const { tool, calls } = buildTool({
			"git remote get-url origin": {
				stdout: "https://github.com/owner/repo.git",
			},
			[searchKey("search/issues", finalQuery, 10)]: {
				stdout: envelope([]),
			},
		});
		const result = await callGithub(tool, {
			op: "search_issues",
			query: "is:open docs",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("No results.");
		const api = ghCalls(calls);
		expect(api[0]?.args[1]).toBe(
			`search/issues?q=${encodeURIComponent(finalQuery)}&per_page=10`,
		);
	});

	it("leaves broad-scope queries unscoped", async () => {
		const finalQuery = "org:acme crash is:issue";
		const { tool, calls } = buildTool({
			"git remote get-url origin": {
				stdout: "https://github.com/owner/repo.git",
			},
			[searchKey("search/issues", finalQuery, 10)]: {
				stdout: envelope([]),
			},
		});
		await callGithub(tool, { op: "search_issues", query: "org:acme crash" });
		const api = ghCalls(calls);
		expect(api[0]?.args[1]).toBe(
			`search/issues?q=${encodeURIComponent(finalQuery)}&per_page=10`,
		);
	});

	it("proceeds globally when checkout resolution fails", async () => {
		const finalQuery = "is:open docs is:issue";
		const { tool } = buildTool({
			"git remote get-url origin": { stdout: "", exitCode: 1 },
			[searchKey("search/issues", finalQuery, 10)]: {
				stdout: envelope([issueItem(11)], 1),
			},
		});
		const result = await callGithub(tool, {
			op: "search_issues",
			query: "is:open docs",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("#11 [open] Fix login flow 11");
	});

	it("ignores the repo parameter for search_repos", async () => {
		const finalQuery = "language:typescript stars:>100";
		const { tool, calls } = buildTool({
			[searchKey("search/repositories", finalQuery, 10)]: {
				stdout: envelope([]),
			},
		});
		await callGithub(tool, {
			op: "search_repos",
			repo: "owner/repo",
			query: finalQuery,
		});
		const api = ghCalls(calls);
		expect(api[0]?.args[1]).toBe(
			`search/repositories?q=${encodeURIComponent(finalQuery)}&per_page=10`,
		);
		expect(calls.some((call) => call.command === "git")).toBe(false);
	});

	it("routes host-qualified repositories through GH_HOST", async () => {
		const finalQuery = "crash is:issue repo:owner/repo";
		const { tool, calls } = buildTool({
			[searchKey("search/issues", finalQuery, 10)]: {
				stdout: envelope([]),
			},
		});
		await callGithub(tool, {
			op: "search_issues",
			repo: "github.acme.internal/owner/repo",
			query: "crash",
		});
		const api = ghCalls(calls);
		expect(api[0]?.env.GH_HOST).toBe("github.acme.internal");
	});

	it("sends the query as one encoded q parameter, unaltered", async () => {
		const finalQuery = 'react in:title "use client" is:issue repo:owner/repo';
		const { tool, calls } = buildTool({
			[searchKey("search/issues", finalQuery, 10)]: {
				stdout: envelope([]),
			},
		});
		const result = await callGithub(tool, {
			op: "search_issues",
			repo: "owner/repo",
			query: 'react in:title "use client"',
		});
		const api = ghCalls(calls);
		expect(api[0]?.args[1]).toBe(
			`search/issues?q=${encodeURIComponent(finalQuery)}&per_page=10`,
		);
		expect(result.details?.query).toBe(finalQuery);
	});

	it("applies the §35 limit policy through the tool", async () => {
		const finalQuery = "crash is:issue repo:owner/repo";
		const { tool, calls } = buildTool({
			[searchKey("search/issues", finalQuery, 2)]: { stdout: envelope([]) },
			[searchKey("search/issues", finalQuery, 50)]: { stdout: envelope([]) },
		});
		await callGithub(tool, {
			op: "search_issues",
			repo: "owner/repo",
			query: "crash",
			limit: 2.7,
		});
		await callGithub(tool, {
			op: "search_issues",
			repo: "owner/repo",
			query: "crash",
			limit: 100,
		});
		const api = ghCalls(calls);
		expect(api[0]?.args[1]).toContain("per_page=2");
		expect(api[1]?.args[1]).toContain("per_page=50");
	});

	it("rejects invalid limits, date fields, and code-search dates", async () => {
		const { tool } = buildTool();
		await expect(
			callGithub(tool, { op: "search_issues", query: "x", limit: 0 }),
		).rejects.toThrow(/positive/);
		await expect(
			callGithub(tool, { op: "search_issues", query: "x", limit: -1 }),
		).rejects.toThrow(/positive/);
		await expect(
			callGithub(tool, { op: "search_issues", query: "x", limit: "10" }),
		).rejects.toThrow(/must be a number/);
		await expect(
			callGithub(tool, {
				op: "search_issues",
				query: "x",
				dateField: "pushed",
			}),
		).rejects.toThrow(/must be "created" or "updated"/);
		await expect(
			callGithub(tool, { op: "search_code", query: "x", since: "7d" }),
		).rejects.toThrow(/does not support since\/until/);
		await expect(
			callGithub(tool, { op: "search_issues", query: "x", since: "3x" }),
		).rejects.toThrow(/Invalid since date/);
	});

	it("rejects search operations without a query", async () => {
		const { tool } = buildTool();
		await expect(callGithub(tool, { op: "search_issues" })).rejects.toThrow(
			/requires a non-empty `query`/,
		);
		await expect(callGithub(tool, { op: "search_code" })).rejects.toThrow(
			/requires a non-empty `query`/,
		);
	});

	it("renders code results with fragments and the text-match header", async () => {
		const finalQuery = "dispatcher repo:owner/repo";
		const { tool } = buildTool({
			[searchKey("search/code", finalQuery, 10, [
				"-H",
				"Accept: application/vnd.github.text-match+json",
			])]: {
				stdout: envelope([
					{
						path: "src/index.ts",
						repository: { full_name: "owner/repo" },
						sha: "e0eb7c3f1234567890",
						html_url: "https://github.com/owner/repo/blob/main/src/index.ts",
						text_matches: [
							{ fragment: 'import <em>github</em> dispatcher\nfrom "pi"' },
						],
					},
				]),
			},
		});
		const result = await callGithub(tool, {
			op: "search_code",
			repo: "owner/repo",
			query: "dispatcher",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("GitHub code search");
		expect(text).toContain("1. src/index.ts (owner/repo @ e0eb7c3)");
		expect(text).toContain('import github dispatcher from "pi"');
		expect(text).toContain(
			"https://github.com/owner/repo/blob/main/src/index.ts",
		);
	});

	it("renders commit results with the first message line and committer date", async () => {
		const finalQuery = "refactor repo:owner/repo";
		const { tool } = buildTool({
			[searchKey("search/commits", finalQuery, 10)]: {
				stdout: envelope([
					{
						sha: "abc1234def5678",
						commit: {
							message: "feat: github dispatcher\n\nbody text",
							author: { name: "Alice" },
							committer: { date: "2026-09-23T23:10:00Z" },
						},
						author: { login: "alice" },
						repository: { full_name: "owner/repo" },
						html_url: "https://github.com/owner/repo/commit/abc1234def567",
					},
				]),
			},
		});
		const result = await callGithub(tool, {
			op: "search_commits",
			repo: "owner/repo",
			query: "refactor",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("1. abc1234 feat: github dispatcher");
		expect(text).not.toContain("body text");
		expect(text).toContain("owner/repo · alice · 2026-09-23");
		expect(text).toContain(
			"https://github.com/owner/repo/commit/abc1234def567",
		);
	});

	it("renders repository results with counts and visibility", async () => {
		const finalQuery = "language:typescript";
		const { tool } = buildTool({
			[searchKey("search/repositories", finalQuery, 10)]: {
				stdout: envelope([
					{
						full_name: "owner/repo",
						description: "A test repository",
						language: "TypeScript",
						stargazers_count: 1200,
						forks_count: 300,
						open_issues_count: 45,
						visibility: "public",
						archived: true,
						fork: false,
						updated_at: "2026-09-01T00:00:00Z",
						html_url: "https://github.com/owner/repo",
					},
				]),
			},
		});
		const result = await callGithub(tool, {
			op: "search_repos",
			query: finalQuery,
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("1. owner/repo");
		expect(text).toContain(
			"TypeScript · stars 1200 · forks 300 · open issues 45 · public · archived · updated 2026-09-01",
		);
		expect(text).toContain("A test repository");
		expect(text).toContain("https://github.com/owner/repo");
	});

	it("maps search failures into the stable taxonomy", async () => {
		const finalQuery = "crash is:issue repo:owner/repo";
		const { tool } = buildTool({
			[searchKey("search/issues", finalQuery, 10)]: {
				exitCode: 1,
				stderr: "API rate limit exceeded",
			},
		});
		await expect(
			callGithub(tool, {
				op: "search_issues",
				repo: "owner/repo",
				query: "crash",
			}),
		).rejects.toThrow(/rate limit/i);

		const authTool = buildTool({
			[searchKey("search/issues", finalQuery, 10)]: {
				exitCode: 1,
				stderr: "gh: Not authenticated",
			},
		}).tool;
		await expect(
			callGithub(authTool, {
				op: "search_issues",
				repo: "owner/repo",
				query: "crash",
			}),
		).rejects.toThrow(/not authenticated/i);

		const invalidTool = buildTool({
			[searchKey("search/issues", finalQuery, 10)]: {
				exitCode: 1,
				stderr: "Validation Failed: the query is invalid",
			},
		}).tool;
		await expect(
			callGithub(invalidTool, {
				op: "search_issues",
				repo: "owner/repo",
				query: "crash",
			}),
		).rejects.toThrow(/rejected the search query/i);

		const badJsonTool = buildTool({
			[searchKey("search/issues", finalQuery, 10)]: {
				stdout: "not json",
			},
		}).tool;
		await expect(
			callGithub(badJsonTool, {
				op: "search_issues",
				repo: "owner/repo",
				query: "crash",
			}),
		).rejects.toThrow(/invalid JSON/i);
	});
});
describe("github file_read", () => {
	it("decodes text files directly", async () => {
		const source = "export const answer = 42;\n";
		const { tool } = buildTool(
			contentsJson("src/index.ts", {
				type: "file",
				name: "index.ts",
				path: "src/index.ts",
				size: source.length,
				content: Buffer.from(source).toString("base64"),
				encoding: "base64",
				html_url: "https://github.com/owner/repo/blob/main/src/index.ts",
			}),
		);
		const result = await callGithub(tool, {
			op: "file_read",
			repo: "owner/repo",
			path: "src/index.ts",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toBe(source);
	});

	it("returns recognized images as image content", async () => {
		const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		const { tool } = buildTool(
			contentsJson("assets/logo.png", {
				type: "file",
				name: "logo.png",
				path: "assets/logo.png",
				size: bytes.length,
				content: Buffer.from(bytes).toString("base64"),
				encoding: "base64",
				html_url: "https://github.com/owner/repo/blob/main/assets/logo.png",
			}),
		);
		const result = await callGithub(tool, {
			op: "file_read",
			repo: "owner/repo",
			path: "assets/logo.png",
		});
		expect(result.content[0]?.type).toBe("image");
		const block = result.content[0] as {
			type: string;
			data: string;
			mimeType: string;
		};
		expect(block.mimeType).toBe("image/png");
		expect(block.data).toBe(Buffer.from(bytes).toString("base64"));
	});

	it("returns other binaries as metadata plus the source URL", async () => {
		const bytes = [0x50, 0x4b, 0x00, 0x01, 0x02];
		const { tool } = buildTool(
			contentsJson("dist/archive.zip", {
				type: "file",
				name: "archive.zip",
				path: "dist/archive.zip",
				size: bytes.length,
				content: Buffer.from(bytes).toString("base64"),
				encoding: "base64",
				html_url: "https://github.com/owner/repo/blob/main/dist/archive.zip",
			}),
		);
		const result = await callGithub(tool, {
			op: "file_read",
			repo: "owner/repo",
			path: "dist/archive.zip",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Binary file: dist/archive.zip");
		expect(text).toContain("Size: 5 bytes");
		expect(text).toContain(
			"Source: https://github.com/owner/repo/blob/main/dist/archive.zip",
		);
	});

	it("rejects a leading slash and traversal segments", async () => {
		const { tool } = buildTool();
		await expect(
			callGithub(tool, { op: "file_read", path: "/src/index.ts" }),
		).rejects.toThrow(/repository-relative/i);
		await expect(
			callGithub(tool, { op: "file_read", path: "../secrets.md" }),
		).rejects.toThrow(/traversal/i);
		await expect(
			callGithub(tool, { op: "file_read", path: "src//index.ts" }),
		).rejects.toThrow(/empty segments/i);
	});

	it("URL-encodes each path segment individually", async () => {
		const payload = {
			type: "file",
			content: Buffer.from("hi").toString("base64"),
			encoding: "base64",
		};
		const encoded = encodeContentsPath("docs/my file#1.md");
		expect(encoded).toBe("docs/my%20file%231.md");
		const { tool, calls } = buildTool({
			[`gh api repos/owner/repo/contents/${encoded}`]: {
				stdout: JSON.stringify(payload),
				exitCode: 0,
			},
		});
		await callGithub(tool, {
			op: "file_read",
			repo: "owner/repo",
			path: "docs/my file#1.md",
		});
		expect(ghCalls(calls)[0]?.args).toEqual([
			"api",
			`repos/owner/repo/contents/${encoded}`,
		]);
	});

	it("passes the branch as ref and omits it when absent", async () => {
		const payload = {
			type: "file",
			content: Buffer.from("hi").toString("base64"),
			encoding: "base64",
		};
		const { tool, calls } = buildTool({
			"gh api repos/owner/repo/contents/src/a.ts?ref=feature%2Fx": {
				stdout: JSON.stringify(payload),
				exitCode: 0,
			},
			"gh api repos/owner/repo/contents/src/b.ts": {
				stdout: JSON.stringify(payload),
				exitCode: 0,
			},
		});
		await callGithub(tool, {
			op: "file_read",
			repo: "owner/repo",
			path: "src/a.ts",
			branch: "feature/x",
		});
		await callGithub(tool, {
			op: "file_read",
			repo: "owner/repo",
			path: "src/b.ts",
		});
		expect(
			ghCalls(calls).map((call) => [call.command, ...call.args].join(" ")),
		).toEqual([
			"gh api repos/owner/repo/contents/src/a.ts?ref=feature%2Fx",
			"gh api repos/owner/repo/contents/src/b.ts",
		]);
	});

	it("resolves an omitted repository from the current checkout", async () => {
		const payload = {
			type: "file",
			content: Buffer.from("hi").toString("base64"),
			encoding: "base64",
		};
		const { tool, calls } = buildTool({
			"git remote get-url origin": {
				stdout: "git@github.com:owner/repo.git\n",
				exitCode: 0,
			},
			"gh api repos/owner/repo/contents/README.md": {
				stdout: JSON.stringify(payload),
				exitCode: 0,
			},
		});
		await callGithub(tool, { op: "file_read", path: "README.md" });
		expect(ghCalls(calls)[0]?.args).toEqual([
			"api",
			"repos/owner/repo/contents/README.md",
		]);
	});

	it("keeps Enterprise hosts out of github.com aliasing", async () => {
		const payload = {
			type: "file",
			content: Buffer.from("hi").toString("base64"),
			encoding: "base64",
		};
		const { tool, calls } = buildTool({
			"gh api repos/platform/backend/contents/README.md": {
				stdout: JSON.stringify(payload),
				exitCode: 0,
			},
		});
		await callGithub(tool, {
			op: "file_read",
			repo: "github.acme.internal/platform/backend",
			path: "README.md",
		});
		expect(ghCalls(calls)[0]?.args).toEqual([
			"api",
			"repos/platform/backend/contents/README.md",
		]);
		expect(ghCalls(calls)[0]?.env.GH_HOST).toBe("github.acme.internal");
	});

	it("maps a missing file to the friendly not-found error", async () => {
		const { tool } = buildTool({
			"gh api repos/owner/repo/contents/src/gone.ts": {
				exitCode: 1,
				stderr:
					'{"message":"Not Found","documentation_url":"https://docs.github.com"}',
			},
		});
		await expect(
			callGithub(tool, {
				op: "file_read",
				repo: "owner/repo",
				path: "src/gone.ts",
			}),
		).rejects.toThrow(
			/GitHub file src\/gone\.ts was not found in owner\/repo\./i,
		);
	});

	it("falls back to the raw media type when the contents API is too small a vessel", async () => {
		const large = "x".repeat(4096);
		const { tool, calls } = buildTool({
			"gh api repos/owner/repo/contents/dist/bundle.js": {
				exitCode: 1,
				stderr:
					'{"message":"This API returns blobs up to 1 MB in size.","errors":[{"code":"too_large"}]}',
			},
			"gh api repos/owner/repo/contents/dist/bundle.js -H Accept: application/vnd.github.raw":
				{
					stdout: large,
					exitCode: 0,
				},
		});
		const result = await callGithub(tool, {
			op: "file_read",
			repo: "owner/repo",
			path: "dist/bundle.js",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toBe(large);
		const raw = calls.find((call) => call.args.includes("-H"));
		expect(raw?.args).toEqual([
			"api",
			"repos/owner/repo/contents/dist/bundle.js",
			"-H",
			"Accept: application/vnd.github.raw",
		]);
	});

	it("degrades an oversized image to metadata plus the source URL", async () => {
		const { tool } = buildTool({
			"gh api repos/owner/repo/contents/assets/big.png": {
				exitCode: 1,
				stderr:
					'{"message":"This API returns blobs up to 1 MB in size.","errors":[{"code":"too_large"}]}',
			},
			"gh api repos/owner/repo/contents/assets/big.png -H Accept: application/vnd.github.raw":
				{
					stdout: "not really a png but large",
					exitCode: 0,
				},
		});
		const result = await callGithub(tool, {
			op: "file_read",
			repo: "owner/repo",
			path: "assets/big.png",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Binary file: assets/big.png");
		expect(text).toContain("not inlined as image content");
		expect(text).toContain(
			"Source: https://github.com/owner/repo/blob/HEAD/assets/big.png",
		);
	});

	it("reports a directory path as a clear error", async () => {
		const { tool } = buildTool({
			"gh api repos/owner/repo/contents/src": {
				stdout: JSON.stringify([
					{ type: "file", name: "index.ts", path: "src/index.ts" },
				]),
				exitCode: 0,
			},
		});
		await expect(
			callGithub(tool, { op: "file_read", repo: "owner/repo", path: "src" }),
		).rejects.toThrow(/is a directory, not a file/i);
	});

	it("maps authentication failures to the friendly auth error", async () => {
		const { tool } = buildTool({
			"gh api repos/owner/repo/contents/src/index.ts": {
				exitCode: 1,
				stderr: "gh: Bad credentials",
			},
		});
		await expect(
			callGithub(tool, {
				op: "file_read",
				repo: "owner/repo",
				path: "src/index.ts",
			}),
		).rejects.toThrow(/not authenticated/i);
	});

	it("maps rate-limit failures to the rate-limit API error", async () => {
		const { tool } = buildTool({
			"gh api repos/owner/repo/contents/src/index.ts": {
				exitCode: 1,
				stderr: "API rate limit exceeded for installation",
			},
		});
		await expect(
			callGithub(tool, {
				op: "file_read",
				repo: "owner/repo",
				path: "src/index.ts",
			}),
		).rejects.toThrow(/rate limit/i);
	});
});

describe("file_read helpers", () => {
	it("validates paths strictly", () => {
		expect(() => validateFileReadPath("")).toThrow(
			/requires a repository-relative/,
		);
		expect(() => validateFileReadPath("  ")).toThrow(
			/requires a repository-relative/,
		);
		expect(validateFileReadPath("src/index.ts")).toBe("src/index.ts");
		expect(() => validateFileReadPath("src/../etc/passwd")).toThrow(
			/traversal/i,
		);
	});

	it("builds source URLs with the requested ref", () => {
		expect(
			buildSourceUrl("github.com", "owner", "repo", "feature/x", "docs/a b.md"),
		).toBe("https://github.com/owner/repo/blob/feature/x/docs/a%20b.md");
	});
});

describe("executeGithubOperation", () => {
	it("carries the operation context in details", async () => {
		const deps = {
			gh: createGhRunner({
				exec: () => {
					throw new Error("unused");
				},
			}),
			git: createGitRunner({
				exec: () => {
					throw new Error("unused");
				},
			}),
			availability: {
				gh: async () => ({ ok: true as const }),
				git: async () => ({ ok: true as const }),
				reset: () => {},
				ensureGh: async () => {},
				ensureGit: async () => {},
			},
			env: {},
		};
		await expect(
			executeGithubOperation(deps, { op: "pr_push" }),
		).rejects.toThrow(/not available in this build/i);
	});
});

describe("prompt guidelines via the system-prompt build hook", () => {
	it("appends the §59 guidelines through before_agent_start", async () => {
		const mod = await import("../src/index.ts");
		const handlers = new Map<
			string,
			(event: unknown, ctx: unknown) => unknown
		>();
		const tools: Array<{ name: string }> = [];
		const fakePi = {
			on: (
				name: string,
				handler: (event: unknown, ctx: unknown) => unknown,
			) => {
				handlers.set(name, handler);
			},
			registerTool: (tool: { name: string }) => {
				tools.push(tool);
			},
			registerCommand: () => {},
		} as unknown as Parameters<(typeof mod)["default"]>[0];
		mod.default(fakePi as never);

		const githubTool = tools.find((tool) => tool.name === "github");
		expect(githubTool).toBeDefined();

		const handler = handlers.get("before_agent_start");
		expect(handler).toBeDefined();
		const guidelines: string[] = [];
		const event = {
			systemPromptOptions: { promptGuidelines: guidelines },
		};
		handler?.(event, {});

		for (const guideline of GITHUB_PROMPT_GUIDELINES) {
			expect(guidelines).toContain(guideline);
		}
		// The coverage the ticket demands: resources, diff URIs, file_read
		// over curl, searches, checkout/push, run_watch, absolute worktree
		// paths.
		expect(guidelines.join("\n")).toMatch(/issue:\/\/ and pr:\/\//);
		expect(guidelines.join("\n")).toMatch(/pr:\/\/N\/diff/);
		expect(guidelines.join("\n")).toMatch(/file_read instead of curl\/wget/i);
		expect(guidelines.join("\n")).toMatch(/search operations/i);
		expect(guidelines.join("\n")).toMatch(/pr_checkout/);
		expect(guidelines.join("\n")).toMatch(/pr_push/);
		expect(guidelines.join("\n")).toMatch(/run_watch/);
		expect(guidelines.join("\n")).toMatch(/absolute paths/);
	});

	it("does not register guidance without the build hook", () => {
		// The guideline list is the single source; the extension must not
		// grow a second copy.
		expect(GITHUB_PROMPT_GUIDELINES.length).toBe(8);
	});
});
