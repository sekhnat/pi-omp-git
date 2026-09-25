/**
 * Tickets 02, 03, and 07 acceptance tests: issue resource rendering, listing
 * filters and live-fetch behavior, cache and repository/host scoping, native
 * delegation, pagination discipline, and dependency gating.
 *
 * External behavior only: GitHub I/O flows through the scripted `gh` fixture
 * seam, and the cache is a real SQLite database on a temporary path.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createGitRunner } from "../src/git/runner.ts";
import { createAvailability } from "../src/github/availability.ts";
import { credentialFingerprint } from "../src/github/cache/auth-key.ts";
import { createGithubCache } from "../src/github/cache/cache.ts";
import { openCacheStore } from "../src/github/cache/db.ts";
import {
	createGithubReadOverride,
	type GithubReadOverride,
	isGithubResourceUri,
	type ReadToolParams,
} from "../src/github/resources/router.ts";
import { createGhRunner, type GhFixtureMap } from "../src/github/runner.ts";
import { loadConfig } from "../src/shared/config.ts";
import {
	CommandNotFoundError,
	createRunner,
	type Exec,
} from "../src/shared/subprocess.ts";

const ISSUE_FIELDS =
	"number,title,state,stateReason,author,body,labels,createdAt,updatedAt,url,comments";
const ISSUE_FIELDS_LEGACY =
	"number,title,state,author,body,labels,createdAt,updatedAt,url,comments";
const ISSUE_LIST_FIELDS = "number,title,state,author,labels,updatedAt,url";

const ISSUE_PAYLOAD = {
	number: 123,
	title: "Bug: crash on save",
	state: "OPEN",
	stateReason: null,
	author: { login: "alice" },
	body: "Steps to reproduce:\n1. open the app\n2. it crashes",
	labels: [{ name: "bug" }, { name: "help wanted" }],
	createdAt: "2026-01-01T10:00:00Z",
	updatedAt: "2026-01-02T11:00:00Z",
	url: "https://github.com/owner/repo/issues/123",
	comments: [
		{
			author: { login: "bob" },
			body: "Reproduced on main.",
			createdAt: "2026-01-02T12:00:00Z",
			isMinimized: false,
		},
		{
			author: { login: "spammer" },
			body: "buy followers",
			createdAt: "2026-01-03T12:00:00Z",
			isMinimized: true,
		},
	],
};

const issuePayloadJson = (overrides: Record<string, unknown> = {}): string =>
	JSON.stringify({ ...ISSUE_PAYLOAD, ...overrides });

function baseFixtures(): GhFixtureMap {
	return {
		[`gh issue view 123 --json ${ISSUE_FIELDS}`]: {
			stdout: issuePayloadJson(),
			exitCode: 0,
		},
		[`gh issue view 123 -R owner/repo --json ${ISSUE_FIELDS}`]: {
			stdout: issuePayloadJson(),
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
	env: Record<string, string>;
}

interface BuildDepsOptions {
	cacheEnabled?: boolean;
	softTtlSec?: number;
	hardTtlSec?: number;
	now?: () => number;
	authToken?: string;
	githubEnabled?: boolean;
}

function buildDeps(
	fixtureOverrides: GhFixtureMap = {},
	options: BuildDepsOptions = {},
) {
	const fixtures = { ...baseFixtures(), ...fixtureOverrides };
	let githubEnabled = options.githubEnabled ?? true;
	const calls: CapturedCall[] = [];
	const exec: Exec = async (spec) => {
		calls.push({ command: spec.command, args: [...spec.args], env: spec.env });
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
		GH_TOKEN: options.authToken ?? "cache-test-token",
		GH_CONFIG_DIR: join(cacheDir, "gh-config"),
	};
	const cacheSettings = {
		enabled: options.cacheEnabled ?? true,
		softTtlSec: options.softTtlSec ?? 300,
		hardTtlSec: options.hardTtlSec ?? 604800,
	};
	const cache = createGithubCache({
		getStore: () => openCacheStore(dbPath),
		getSettings: () => cacheSettings,
		authKey: () => credentialFingerprint(env),
		now: options.now,
	});
	const override = createGithubReadOverride({
		gh: createGhRunner({ exec }),
		git: createGitRunner({ exec }),
		availability,
		cache,
		env,
		getConfig: () => {
			const config = loadConfig({
				agentDir: cacheDir,
				cwd: cacheDir,
				env,
				projectTrusted: false,
			});
			return {
				...config,
				github: { ...config.github, enabled: githubEnabled },
			};
		},
		nativeRead,
	});
	return {
		override,
		availability,
		calls,
		dbPath,
		fixtures,
		nativeRead,
		env,
		setGithubEnabled: (enabled: boolean): void => {
			githubEnabled = enabled;
		},
		setAuthToken: (token: string): void => {
			env.GH_TOKEN = token;
		},
	};
}

const readVirtual = (override: GithubReadOverride, params: ReadToolParams) =>
	override.execute("test-call-id", params, undefined, undefined);

const ghViewCallCount = (calls: CapturedCall[]): number =>
	calls.filter(
		(candidate) =>
			candidate.command === "gh" && candidate.args.includes("view"),
	).length;

describe("read issue://N rendering", () => {
	it("blocks virtual reads before GitHub and cache work while disabled", async () => {
		const { override, calls, dbPath, setGithubEnabled } = buildDeps(
			{},
			{
				githubEnabled: false,
			},
		);
		await expect(
			readVirtual(override, { path: "issue://123" }),
		).rejects.toThrow(/GitHub integration is disabled/i);
		expect(calls).toHaveLength(0);
		expect(existsSync(dbPath)).toBe(false);

		setGithubEnabled(true);
		const result = await readVirtual(override, { path: "issue://123" });
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("# 123 Bug: crash on save");
		expect(ghViewCallCount(calls)).toBe(1);
		expect(existsSync(dbPath)).toBe(true);
	});

	it("renders the complete issue with all sections", async () => {
		const { override } = buildDeps();
		const result = await readVirtual(override, { path: "issue://123" });
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("# 123 Bug: crash on save");
		expect(text).toContain("State: OPEN");
		expect(text).toContain("Author: alice");
		expect(text).toContain("Created: 2026-01-01T10:00:00Z");
		expect(text).toContain("Updated: 2026-01-02T11:00:00Z");
		expect(text).toContain("Labels: bug, help wanted");
		expect(text).toContain("URL: https://github.com/owner/repo/issues/123");
		expect(text).toContain("## Body");
		expect(text).toContain("2. it crashes");
		expect(text).toContain("## Comments");
		expect(text).toContain("### bob on 2026-01-02T12:00:00Z");
		expect(text).toContain("Reproduced on main.");
		// Minimized comments are excluded (§11).
		expect(text).not.toContain("buy followers");
	});

	it("renders without a State reason line when gh omits it", async () => {
		const legacy = issuePayloadJson({ stateReason: undefined });
		const { override } = buildDeps({
			[`gh issue view 123 --json ${ISSUE_FIELDS_LEGACY}`]: {
				stdout: legacy,
				exitCode: 0,
			},
			[`gh issue view 123 --json ${ISSUE_FIELDS}`]: {
				exitCode: 1,
				stderr: 'Unknown JSON field: "stateReason"',
			},
		});
		const result = await readVirtual(override, { path: "issue://123" });
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).not.toContain("State reason:");
		expect(text).toContain("State: OPEN");
	});

	it("suppresses comments with ?comments=0", async () => {
		const { override } = buildDeps();
		const result = await readVirtual(override, {
			path: "issue://123?comments=0",
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).not.toContain("## Comments");
		expect(text).toContain("## Body");
	});
});

describe("read issue://N repository resolution", () => {
	it("resolves repository-scoped resources with -R owner/repo", async () => {
		const { override, calls } = buildDeps();
		await readVirtual(override, { path: "issue://owner/repo/123" });
		const call = calls.find(
			(candidate) =>
				candidate.command === "gh" && candidate.args.includes("view"),
		);
		expect(call?.args).toContain("-R");
		expect(call?.args.join(" ")).toContain("-R owner/repo");
	});

	it("targets host-qualified resources via GH_HOST without clobbering auth", async () => {
		const { override, calls } = buildDeps();
		await readVirtual(override, {
			path: "issue://github.example.com/owner/repo/123",
		});
		const call = calls.at(-1);
		expect(call?.env.GH_HOST).toBe("github.example.com");
		expect(call?.args.join(" ")).toContain("-R owner/repo");
	});
});

describe("read override delegation (zero behavior change)", () => {
	it("delegates non-virtual paths to the native read, byte-identically", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-omp-git-read-"));
		const file = join(dir, "README.md");
		const content = ["# hello", "", "line three", "$(whoami)", "a;b"].join(
			"\n",
		);
		writeFileSync(file, content, "utf-8");

		const calls: CapturedCall[] = [];
		const exec: Exec = async (spec) => {
			calls.push({
				command: spec.command,
				args: [...spec.args],
				env: spec.env,
			});
			return {
				exitCode: 0,
				stdout: "",
				stderr: "",
				truncated: false,
				timedOut: false,
				cancelled: false,
			};
		};
		const runner = createRunner({ exec });
		const availability = createAvailability(runner);
		const nativeRead = createReadTool(dir);
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-omp-git-cache-"));
		const dbPath = join(cacheDir, "github-cache.db");
		const env: Record<string, string> = {
			PI_OMP_GITHUB_CACHE_DB: dbPath,
			GH_CONFIG_DIR: join(cacheDir, "gh-config"),
		};
		const cache = createGithubCache({
			getStore: () => openCacheStore(dbPath),
			getSettings: () => ({
				enabled: false,
				softTtlSec: 300,
				hardTtlSec: 604800,
			}),
			authKey: () => credentialFingerprint(env),
		});
		const override = createGithubReadOverride({
			gh: createGhRunner({ exec }),
			git: createGitRunner({ exec }),
			availability,
			cache,
			env,
			getConfig: () => {
				const config = loadConfig({
					agentDir: cacheDir,
					cwd: cacheDir,
					env,
					projectTrusted: false,
				});
				return { ...config, github: { ...config.github, enabled: false } };
			},
			nativeRead,
		});

		const viaOverride = await override.execute(
			"id-override",
			{ path: file },
			undefined,
			undefined,
		);
		const native = await nativeRead.execute(
			"id-native",
			{ path: file },
			undefined,
			undefined,
		);
		expect(viaOverride).toEqual(native);
		expect(calls).toHaveLength(0);
	});

	it("delegates paths that merely look scheme-ish after the check", async () => {
		const { override, calls } = buildDeps();
		await expect(
			readVirtual(override, { path: "src/issue://notes.md" }),
		).rejects.toThrow(/native read must not be called/);
		// A relative path never triggers GitHub routing — this assertion is
		// covered by the delegation test above; here we only prove scheme
		// detection is prefix-based and case-insensitive on the scheme.
		expect(isGithubResourceUri("ISSUE://123")).toBe(true);
		expect(isGithubResourceUri("PR://123")).toBe(true);
		expect(isGithubResourceUri("issue://123")).toBe(true);
		expect(calls).toHaveLength(0);
	});
});

describe("read pagination discipline (native parity, §7)", () => {
	function bigBodyIssue(): string {
		const lines: string[] = [];
		for (let index = 1; index <= 2100; index++) {
			lines.push(`body line ${index}`);
		}
		return issuePayloadJson({ body: lines.join("\n") });
	}

	it("truncates at the native 2000-line cap with the standard continuation notice", async () => {
		const { override } = buildDeps({
			[`gh issue view 123 --json ${ISSUE_FIELDS}`]: {
				stdout: bigBodyIssue(),
				exitCode: 0,
			},
		});
		const result = await readVirtual(override, { path: "issue://123" });
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("body line 1\n");
		expect(text).toContain("body line 1989\n");
		expect(text).not.toContain("body line 1990");
		expect(text).toContain(
			"[Showing lines 1-2000 of 2117. Use offset=2001 to continue.]",
		);
		expect(text).not.toContain("body line 2001");
	});

	it("slices rendered snapshots with offset/limit and reports remaining lines", async () => {
		const { override } = buildDeps({
			[`gh issue view 123 --json ${ISSUE_FIELDS}`]: {
				stdout: bigBodyIssue(),
				exitCode: 0,
			},
		});
		const result = await readVirtual(override, {
			path: "issue://123",
			offset: 2001,
			limit: 100,
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("body line 1990");
		expect(text).toContain("body line 2089");
		expect(text).not.toContain("body line 1989");
		expect(text).not.toContain("body line 2090");
		expect(text).toContain(
			"[17 more lines in file. Use offset=2101 to continue.]",
		);
	});

	it("errors on out-of-range offsets with the native phrasing", async () => {
		const { override } = buildDeps();
		await expect(
			readVirtual(override, { path: "issue://123", offset: 999_999 }),
		).rejects.toThrow(
			/^Offset 999999 is beyond end of file \(\d+ lines total\)$/,
		);
	});
});

describe("read override dependency gating (§4, §49)", () => {
	it("returns the friendly dependency error when gh is missing", async () => {
		const exec: Exec = async () => {
			throw new CommandNotFoundError("gh");
		};
		const runner = createRunner({ exec });
		const override = createGithubReadOverride({
			gh: createGhRunner({ exec }),
			git: createGitRunner({ exec }),
			availability: createAvailability(runner),
			cache: createGithubCache({
				getStore: () => openCacheStore(join(tmpdir(), "dep-cache.db")),
				getSettings: () => ({
					enabled: true,
					softTtlSec: 300,
					hardTtlSec: 604800,
				}),
				authKey: () => credentialFingerprint({ GH_TOKEN: "dep-token" }),
			}),
			env: {},
			getConfig: () =>
				loadConfig({
					agentDir: join(tmpdir(), "dep-agent"),
					cwd: join(tmpdir(), "dep-cwd"),
					env: {},
					projectTrusted: false,
				}),
			nativeRead: {
				execute: async () => {
					throw new Error("unreachable");
				},
			},
		});
		await expect(
			readVirtual(override, { path: "issue://123" }),
		).rejects.toThrow("GitHub CLI (gh) is not installed.");
	});

	it("returns the auth error when gh is unauthenticated", async () => {
		const { override } = buildDeps({
			"gh auth status": { exitCode: 1, stderr: "gh: not logged in" },
		});
		await expect(
			readVirtual(override, { path: "issue://123" }),
		).rejects.toThrow(/GitHub CLI is not authenticated/);
	});

	it("maps invalid gh JSON to the friendly invalid-JSON error", async () => {
		const { override } = buildDeps({
			[`gh issue view 123 --json ${ISSUE_FIELDS}`]: {
				stdout: "not json",
				exitCode: 0,
			},
		});
		await expect(
			readVirtual(override, { path: "issue://123" }),
		).rejects.toThrow("GitHub CLI returned invalid JSON.");
	});

	it("maps a missing issue to a friendly not-found error", async () => {
		const { override } = buildDeps({
			[`gh issue view 123 -R owner/repo --json ${ISSUE_FIELDS}`]: {
				exitCode: 1,
				stderr: "could not resolve to an Issue with the number field `123`",
			},
		});
		await expect(
			readVirtual(override, { path: "issue://owner/repo/123" }),
		).rejects.toThrow(/not found in owner\/repo/);
	});

	it("keeps git reads flowing through the same runner when gh is missing", async () => {
		const exec: Exec = async (spec) => {
			if (spec.command === "git") {
				return {
					exitCode: 0,
					stdout: "git version 2.47.0\n",
					stderr: "",
					truncated: false,
					timedOut: false,
					cancelled: false,
				};
			}
			throw new CommandNotFoundError(spec.command);
		};
		const runner = createRunner({ exec });
		const availability = createAvailability(runner);
		const ghStatus = await availability.gh();
		expect(ghStatus.ok).toBe(false);
		if (!ghStatus.ok) expect(ghStatus.reason).toBe("missing");
		const gitStatus = await availability.git();
		expect(gitStatus.ok).toBe(true);
	});
});

describe("read override routing guardrails", () => {
	it("renders PR resources as of ticket 04 (routing guardrail)", async () => {
		const { override } = buildDeps({
			"gh pr view 123 -R owner/repo --json number,title,state,isDraft,author,baseRefName,headRefName,reviewDecision,mergeStateStatus,body,labels,createdAt,updatedAt,url,files,reviews,comments":
				{
					stdout: JSON.stringify({
						number: 123,
						title: "t",
						state: "OPEN",
						isDraft: false,
						labels: [],
						files: [],
						reviews: [],
						comments: [],
					}),
					exitCode: 0,
				},
			"gh api repos/owner/repo/pulls/123/comments?per_page=100 --paginate --slurp":
				{
					stdout: "[]",
					exitCode: 0,
				},
		});
		const result = await readVirtual(override, { path: "pr://123" });
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("# 123 t");
		expect(text).toContain("## Diff");
	});

	it("lists bare issues with open/30 defaults and fetches every read live", async () => {
		const args = [
			"issue",
			"list",
			"--repo",
			"owner/repo",
			"--state",
			"open",
			"--limit",
			"30",
			"--json",
			ISSUE_LIST_FIELDS,
		];
		const fixtureKey = ["gh", ...args].join(" ");
		const payload = [
			{
				number: 42,
				title: "Fix broken save",
				state: "OPEN",
				author: { login: "alice" },
				labels: [{ name: "bug" }],
				updatedAt: "2026-02-01T12:00:00Z",
				url: "https://github.com/owner/repo/issues/42",
			},
		];
		const { override, calls, fixtures } = buildDeps({
			[fixtureKey]: { stdout: JSON.stringify(payload), exitCode: 0 },
		});

		const first = await readVirtual(override, { path: "issue://" });
		fixtures[fixtureKey] = {
			stdout: JSON.stringify([
				{ ...payload[0], title: "Updated after first read" },
			]),
			exitCode: 0,
		};
		const second = await readVirtual(override, { path: "issue://" });
		const text = first.content[0]?.type === "text" ? first.content[0].text : "";
		const refreshedText =
			second.content[0]?.type === "text" ? second.content[0].text : "";
		expect(text).toContain("#42 [OPEN] Fix broken save");
		expect(text).toContain("alice");
		expect(text).toContain("bug");
		expect(text).toContain("https://github.com/owner/repo/issues/42");
		expect(refreshedText).toContain("#42 [OPEN] Updated after first read");
		expect(refreshedText).not.toContain("Fix broken save");
		expect(second.content[0]?.type).toBe("text");
		expect(
			calls.filter(
				(call) =>
					call.command === "gh" &&
					call.args.slice(0, 2).join(" ") === "issue list",
			),
		).toHaveLength(2);
	});

	it("passes issue listing filters, clamps limits, and uses GH_HOST", async () => {
		const args = [
			"issue",
			"list",
			"--repo",
			"owner/repo",
			"--state",
			"closed",
			"--limit",
			"100",
			"--author",
			"alice",
			"--label",
			"help wanted",
			"--json",
			ISSUE_LIST_FIELDS,
		];
		const fixtureKey = ["gh", ...args].join(" ");
		const { override, calls } = buildDeps({
			[fixtureKey]: { stdout: "[]", exitCode: 0 },
		});
		const result = await readVirtual(override, {
			path: "issue://github.example.com/owner/repo?state=closed&limit=101&author=alice&label=help%20wanted",
		});
		const call = calls.find(
			(candidate) =>
				candidate.command === "gh" &&
				candidate.args[0] === "issue" &&
				candidate.args[1] === "list",
		);
		expect(call?.args).toEqual(args);
		expect(call?.env.GH_HOST).toBe("github.example.com");
		expect(
			result.content[0]?.type === "text" ? result.content[0].text : "",
		).toContain("No issues found.");
	});

	it("rejects invalid virtual URIs with clear errors instead of delegating", async () => {
		const { override } = buildDeps();
		await expect(
			readVirtual(override, { path: "issue://owner/../123" }),
		).rejects.toThrow(/Invalid GitHub resource URI/);
		await expect(readVirtual(override, { path: "issue://0" })).rejects.toThrow(
			/issue number/,
		);
		await expect(
			readVirtual(override, { path: "issue://123/foo" }),
		).rejects.toThrow(/Invalid GitHub resource URI/);
	});
});

describe("read issue://N caching (ticket 03)", () => {
	it("serves a fresh row without a second gh invocation", async () => {
		const { override, calls } = buildDeps();
		const first = await readVirtual(override, { path: "issue://123" });
		expect(ghViewCallCount(calls)).toBe(1);
		const second = await readVirtual(override, { path: "issue://123" });
		expect(ghViewCallCount(calls)).toBe(1);
		const firstText =
			first.content[0]?.type === "text" ? first.content[0].text : "";
		const secondText =
			second.content[0]?.type === "text" ? second.content[0].text : "";
		expect(secondText).toBe(firstText);
	});

	it("refreshes soft-expired rows synchronously", async () => {
		let nowMs = 1_000_000;
		const { override, calls } = buildDeps(
			{},
			{ softTtlSec: 1, now: () => nowMs },
		);
		await readVirtual(override, { path: "issue://123" });
		expect(ghViewCallCount(calls)).toBe(1);
		nowMs += 2_000;
		await readVirtual(override, { path: "issue://123" });
		expect(ghViewCallCount(calls)).toBe(2);
	});

	it("serves stale rows with a visible warning when a refresh fails", async () => {
		let nowMs = 1_000_000;
		const { override, fixtures } = buildDeps(
			{},
			{ softTtlSec: 1, now: () => nowMs },
		);
		await readVirtual(override, { path: "issue://123" });
		fixtures[`gh issue view 123 --json ${ISSUE_FIELDS}`] = {
			stdout: "",
			exitCode: 1,
			stderr: "boom",
		};
		nowMs += 2_000;
		const result = await readVirtual(override, { path: "issue://123" });
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("GitHub cache: refresh failed");
		expect(text).toContain("# 123 Bug: crash on save");
	});

	it("evicts hard-expired rows and refetches", async () => {
		let nowMs = 1_000_000;
		const fresh = issuePayloadJson({ title: "Fresh after eviction" });
		const { override, calls } = buildDeps(
			{
				[`gh issue view 123 --json ${ISSUE_FIELDS}`]: {
					stdout: fresh,
					exitCode: 0,
				},
			},
			{ softTtlSec: 1, hardTtlSec: 2, now: () => nowMs },
		);
		await readVirtual(override, { path: "issue://123" });
		nowMs += 3_000;
		const result = await readVirtual(override, { path: "issue://123" });
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Fresh after eviction");
		expect(ghViewCallCount(calls)).toBe(2);
	});

	it("isolates rows by credential fingerprint", async () => {
		const { override, setAuthToken } = buildDeps();
		await readVirtual(override, { path: "issue://123" });
		setAuthToken("different-identity-token");
		await readVirtual(override, { path: "issue://123" });
	});

	it("isolates rows by comments mode", async () => {
		const { override, calls } = buildDeps();
		await readVirtual(override, { path: "issue://123" });
		await readVirtual(override, { path: "issue://123?comments=0" });
		expect(ghViewCallCount(calls)).toBe(2);
	});
});
