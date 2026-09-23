/**
 * Ticket 10 acceptance tests: `pr_create` with `fill` and the nested
 * agent machinery (docs/pi-omp-git-reference.md §22, §75).
 *
 * External behavior only: gh/git flow through the scripted fixture seam;
 * the nested agent session is driven by a scripted factory at the SDK
 * boundary.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createGitRunner } from "../src/git/runner.ts";
import { createAvailability } from "../src/github/availability.ts";
import {
	createGithubTool,
	type GithubTool,
	type GithubToolContext,
	type GithubToolDetails,
} from "../src/github/dispatcher.ts";
import type { NestedSessionFactory } from "../src/github/nested-agent.ts";
import {
	FILL_AGENT_TOOLS,
	parseCreatedPrUrl,
	parseFillResponse,
	validatePrCreateArguments,
} from "../src/github/operations/pr-create.ts";
import { PR_FIELDS_NO_COMMENTS } from "../src/github/resources/prs.ts";
import { createGhRunner } from "../src/github/runner.ts";
import { createRunner, type Exec } from "../src/shared/subprocess.ts";

interface CapturedCall {
	command: string;
	args: string[];
	env: Record<string, string>;
}

interface Fixture {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
}

function buildTool(
	fixtures: Record<string, Fixture>,
	options: {
		nestedSession?: { text?: string; error?: Error };
		model?: GithubToolContext["model"];
		cwd?: string;
		tempDir?: string;
	} = {},
) {
	const merged: Record<string, Fixture> = {
		"gh --version": { stdout: "gh version 2.40.0\n", exitCode: 0 },
		"gh auth status": { exitCode: 0 },
		...fixtures,
	};
	const calls: CapturedCall[] = [];
	const exec: Exec = async (spec) => {
		calls.push({
			command: spec.command,
			args: [...spec.args],
			env: spec.env,
		});
		const key = [spec.command, ...spec.args].join(" ");
		const fixture = merged[key];
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

	// The nested-agent seam: the factory records the SDK options and the
	// session records the prompt, returning a scripted response.
	const factoryCalls: Array<Record<string, unknown>> = [];
	const prompts: string[] = [];
	let disposed = false;
	const nestedSession: NestedSessionFactory | undefined = options.nestedSession
		? async (factoryOptions) => {
				factoryCalls.push(factoryOptions as unknown as Record<string, unknown>);
				const session: FakeSessionShape = {
					prompt: async (text: string) => {
						prompts.push(text);
					},
					abort: () => {},
					getLastAssistantText: () => options.nestedSession?.text,
					dispose: () => {
						disposed = true;
					},
				};
				return { session };
			}
		: undefined;

	const tool = createGithubTool({
		gh: createGhRunner({ exec }),
		git: createGitRunner({ exec }),
		availability: createAvailability(runner),
		env: { GH_TOKEN: "test-token" },
		createNestedSession: nestedSession,
		tempDir: options.tempDir,
	});
	return { tool, calls, factoryCalls, prompts, disposed: () => disposed };
}

interface FakeSessionShape {
	prompt: (text: string) => Promise<void>;
	abort: () => void;
	getLastAssistantText: () => string | undefined;
	dispose: () => void;
}

const callGithub = (
	tool: GithubTool,
	params: Record<string, unknown> | null,
	ctx?: GithubToolContext,
): Promise<AgentToolResult<GithubToolDetails>> =>
	tool.execute("test-call-id", params as never, undefined, undefined, ctx);

/** gh calls minus the availability probes (--version, auth status). */
const firstText = (result: {
	content: Array<{ type: string; text?: string }>;
}) => result.content.find((block) => block.type === "text")?.text ?? "";
const ghCalls = (calls: CapturedCall[]) =>
	calls.filter(
		(call) =>
			call.command === "gh" &&
			call.args[0] !== "--version" &&
			!(call.args[0] === "auth" && call.args[1] === "status"),
	);

const GIT_FIXTURES = {
	"git rev-parse --abbrev-ref HEAD": { stdout: "feature/login\n" },
	"git symbolic-ref refs/remotes/origin/HEAD": {
		stdout: "refs/remotes/origin/main\n",
	},
	"git merge-base HEAD main": { stdout: "abc0000\n" },
	"git log --format=%h %s%n%b%n--- abc0000..HEAD": {
		stdout: "abc1234 feat: add login flow\n\nLonger explanation.\n---\n",
	},
	"git diff --stat abc0000..HEAD": {
		stdout: "src/login.ts | 12 +++++++\n 1 file changed\n",
	},
};

const CREATED_URL = "https://github.com/owner/repo/pull/42";

const refreshFixture = () => ({
	[`gh pr view 42 -R owner/repo --json ${PR_FIELDS_NO_COMMENTS}`]: {
		stdout: JSON.stringify({
			number: 42,
			title: "Add login flow",
			state: "OPEN",
			isDraft: false,
			author: { login: "alice" },
			baseRefName: "main",
			headRefName: "feature/login",
			body: "The body.",
			labels: [{ name: "ui" }],
			createdAt: "2026-09-24T00:00:00Z",
			updatedAt: "2026-09-24T00:00:00Z",
			url: CREATED_URL,
			files: [{ path: "src/login.ts", additions: 12 }],
			reviews: [],
		}),
	},
});

describe("pr_create validation", () => {
	it("rejects fill combined with a title or an explicit body", () => {
		expect(() => validatePrCreateArguments({ fill: true, title: "T" })).toThrow(
			/fill.*cannot be combined with an explicit `title`/,
		);
		expect(() => validatePrCreateArguments({ fill: true, body: "B" })).toThrow(
			/fill.*cannot be combined with an explicit `body`/,
		);
	});

	it("requires a title when fill is absent", () => {
		expect(() => validatePrCreateArguments({})).toThrow(
			/requires an explicit `title` or `fill: true`/,
		);
		expect(() => validatePrCreateArguments({ title: "  " })).toThrow(
			/requires an explicit `title`/,
		);
	});

	it("rejects malformed reviewer, assignee, and label arrays", () => {
		expect(() =>
			validatePrCreateArguments({ title: "T", label: ["ok", ""] }),
		).toThrow(/`label` parameter must be an array/);
		expect(() =>
			validatePrCreateArguments({ title: "T", reviewer: "alice" as never }),
		).toThrow(/`reviewer` parameter must be an array/);
	});
});

describe("pr_create with an explicit title", () => {
	it("creates the PR and serves the rich summary through the refresh", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-omp-git-pr-test-"));
		const { tool, calls } = buildTool(
			{
				["gh pr create --title Add login flow --body-file " +
					`${join(tempDir, "pr-body.md")} -R owner/repo`]: {
					stdout: `${CREATED_URL}\n`,
				},
				...refreshFixture(),
			},
			{ tempDir },
		);
		const result = await callGithub(tool, {
			op: "pr_create",
			repo: "owner/repo",
			title: "Add login flow",
			body: "The body.",
		});
		const api = ghCalls(calls);
		expect(api[0]?.args).toEqual([
			"pr",
			"create",
			"--title",
			"Add login flow",
			"--body-file",
			join(tempDir, "pr-body.md"),
			"-R",
			"owner/repo",
		]);
		const written = readFileSync(join(tempDir, "pr-body.md"), "utf8");
		expect(written).toBe("The body.");
		expect(firstText(result)).toContain("# 42 Add login flow");
		expect(result.details).toMatchObject({
			op: "pr_create",
			url: CREATED_URL,
			number: 42,
		});
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("passes an explicitly empty body as noninteractive --body", async () => {
		const { tool, calls } = buildTool({
			"gh pr create --title Add login flow --body  -R owner/repo": {
				stdout: `${CREATED_URL}\n`,
			},
			...refreshFixture(),
		});
		await callGithub(tool, {
			op: "pr_create",
			repo: "owner/repo",
			title: "Add login flow",
			body: "",
		});
		const api = ghCalls(calls);
		expect(api[0]?.args).toContain("--body");
		expect(api[0]?.args).not.toContain("--body-file");
	});

	it("treats an omitted body as empty so gh never opens an editor", async () => {
		const { tool, calls } = buildTool({
			"gh pr create --title Add login flow --body ": {
				stdout: `${CREATED_URL}\n`,
			},
		});
		await callGithub(tool, { op: "pr_create", title: "Add login flow" });
		const api = ghCalls(calls);
		expect(api[0]?.args).toContain("--body");
	});

	it("passes base, head, draft, and repeated reviewer flags", async () => {
		const { tool, calls } = buildTool({
			["gh pr create --title T --body  --base main --head feature/x" +
				" --draft --reviewer alice --reviewer bob --assignee alice" +
				" --label ui"]: {
				stdout: `${CREATED_URL}\n`,
			},
		});
		await callGithub(tool, {
			op: "pr_create",
			title: "T",
			base: "main",
			head: "feature/x",
			draft: true,
			reviewer: ["alice", "bob"],
			assignee: ["alice"],
			label: ["ui"],
		});
		const api = ghCalls(calls);
		expect(api[0]?.args).toEqual([
			"pr",
			"create",
			"--title",
			"T",
			"--body",
			"",
			"--base",
			"main",
			"--head",
			"feature/x",
			"--draft",
			"--reviewer",
			"alice",
			"--reviewer",
			"bob",
			"--assignee",
			"alice",
			"--label",
			"ui",
		]);
	});

	it("routes host-qualified repositories through GH_HOST", async () => {
		const { tool, calls } = buildTool({
			"gh pr create --title T --body  -R owner/repo": {
				stdout: "https://github.acme.internal/owner/repo/pull/7\n",
			},
			[`gh pr view 7 -R owner/repo --json ${PR_FIELDS_NO_COMMENTS}`]: {
				stdout: JSON.stringify({ number: 7, title: "T", state: "OPEN" }),
			},
		});
		await callGithub(tool, {
			op: "pr_create",
			repo: "github.acme.internal/owner/repo",
			title: "T",
		});
		const api = ghCalls(calls);
		expect(api[0]?.env.GH_HOST).toBe("github.acme.internal");
	});

	it("survives a failed best-effort refresh", async () => {
		const { tool, calls } = buildTool({
			"gh pr create --title T --body  -R owner/repo": {
				stdout: `${CREATED_URL}\n`,
			},
			// No gh pr view fixture → the refresh fails.
		});
		const result = await callGithub(tool, {
			op: "pr_create",
			repo: "owner/repo",
			title: "T",
		});
		const api = ghCalls(calls);
		expect(api).toHaveLength(2);
		expect(api[0]?.args.slice(0, 2)).toEqual(["pr", "create"]);
		expect(api[1]?.args.slice(0, 2)).toEqual(["pr", "view"]);
		expect(firstText(result)).toContain(CREATED_URL);
		expect(firstText(result)).not.toContain("# 42");
	});

	it("maps creation failures into the stable taxonomy", async () => {
		const authTool = buildTool({
			"gh pr create --title T --body ": {
				exitCode: 1,
				stderr: "gh: Not authenticated",
			},
		}).tool;
		await expect(
			callGithub(authTool, { op: "pr_create", title: "T" }),
		).rejects.toThrow(/not authenticated/i);

		const rateTool = buildTool({
			"gh pr create --title T --body ": {
				exitCode: 1,
				stderr: "API rate limit exceeded",
			},
		}).tool;
		await expect(
			callGithub(rateTool, { op: "pr_create", title: "T" }),
		).rejects.toThrow(/rate limit/i);
	});
});

describe("pr_create with fill", () => {
	const FILL_RESPONSE = "Add login flow\n\nThis adds a login flow.";

	it("generates title and body through a nested agent session", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-omp-git-pr-test-"));
		const { tool, calls, factoryCalls, prompts, disposed } = buildTool(
			{
				...GIT_FIXTURES,
				["gh pr create --title Add login flow --body-file " +
					`${join(tempDir, "pr-body.md")} -R owner/repo`]: {
					stdout: `${CREATED_URL}\n`,
				},
				...refreshFixture(),
			},
			{
				tempDir,
				nestedSession: { text: FILL_RESPONSE },
				model: { id: "test-model" } as never,
				cwd: "/repo",
			},
		);
		const result = await callGithub(
			tool,
			{ op: "pr_create", repo: "owner/repo", fill: true },
			{ model: { id: "test-model" } as never, cwd: "/repo" },
		);

		// The nested session ran with the narrow read-only allowlist, the
		// parent's model, no built-in tools, and in-memory session storage.
		expect(factoryCalls).toHaveLength(1);
		const factoryOptions = factoryCalls[0] ?? {};
		expect(factoryOptions).toBeDefined();
		expect(factoryOptions.noTools).toBe("all");
		expect(factoryOptions.tools).toEqual(FILL_AGENT_TOOLS);
		expect(factoryOptions.cwd).toBe("/repo");
		expect(factoryOptions.model).toMatchObject({ id: "test-model" });
		expect(factoryOptions.sessionManager).toBeDefined();
		expect(disposed()).toBe(true);

		// The prompt carried the branch context.
		expect(prompts[0]).toContain("Branch: feature/login");
		expect(prompts[0]).toContain("Target branch: main");
		expect(prompts[0]).toContain("feat: add login flow");
		expect(prompts[0]).toContain("src/login.ts | 12");

		// Creation used the generated title and body via the body file.
		const api = ghCalls(calls);
		expect(api[0]?.args).toEqual([
			"pr",
			"create",
			"--title",
			"Add login flow",
			"--body-file",
			join(tempDir, "pr-body.md"),
			"-R",
			"owner/repo",
		]);
		expect(readFileSync(join(tempDir, "pr-body.md"), "utf8")).toBe(
			"This adds a login flow.",
		);
		expect(result.details).toMatchObject({
			op: "pr_create",
			url: CREATED_URL,
			number: 42,
		});
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("errors when the nested session produces no usable title", async () => {
		const { tool } = buildTool(
			{ ...GIT_FIXTURES },
			{ nestedSession: { text: "   " } },
		);
		await expect(
			callGithub(tool, { op: "pr_create", fill: true }),
		).rejects.toThrow(/returned no usable pull request title/);
	});

	it("fails fill when the current branch cannot be determined", async () => {
		const { tool } = buildTool(
			{
				"git rev-parse --abbrev-ref HEAD": { stdout: "", exitCode: 1 },
			},
			{ nestedSession: { text: "T" } },
		);
		await expect(
			callGithub(tool, { op: "pr_create", fill: true }),
		).rejects.toThrow(/could not determine the current branch/);
	});
});

describe("pr_create helpers", () => {
	it("parses created PR URLs with number and repository identity", () => {
		expect(
			parseCreatedPrUrl(
				"Creating pull request...\nhttps://github.com/owner/repo/pull/42\n",
			),
		).toEqual({
			url: "https://github.com/owner/repo/pull/42",
			number: 42,
			host: "github.com",
			owner: "owner",
			repo: "repo",
		});
		expect(
			parseCreatedPrUrl("https://github.acme.internal/platform/backend/pull/7"),
		).toMatchObject({
			number: 7,
			host: "github.acme.internal",
			owner: "platform",
			repo: "backend",
		});
		expect(parseCreatedPrUrl("no url here")).toEqual({ url: "no url here" });
	});

	it("splits fill responses into title and body", () => {
		expect(
			parseFillResponse("Title\n\nBody line one.\nBody line two."),
		).toEqual({
			title: "Title",
			body: "Body line one.\nBody line two.",
		});
		expect(parseFillResponse("\n\nOnly a title")).toEqual({
			title: "Only a title",
			body: "",
		});
		expect(() => parseFillResponse("")).toThrow(/no usable pull request title/);
	});
});
