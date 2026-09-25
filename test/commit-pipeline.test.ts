/**
 * Tickets 21–23 acceptance tests: the agentic /commit pipeline — single
 * proposals, split execution with conservation, dry-run, hooks, push,
 * and changelog integration (docs/pi-omp-git-reference.md §73–§86,
 * §100). The commit agent runs with deterministic scripted responses;
 * git runs for real in temporary repositories.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CommitPipelineDeps,
	type CommitPipelineOptions,
	runCommitPipeline,
} from "../src/git/commit-pipeline.ts";
import { createGitRunner, type GitRunner } from "../src/git/runner.ts";
import { createGhRunner, type GhRunner } from "../src/github/runner.ts";
import { COMMIT_DEFAULTS } from "../src/shared/config.ts";

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
	const path = mkdtempSync(join(tmpdir(), "pi-omp-git-commit-"));
	tempDirs.push(path);
	git(["init", "-q", "--initial-branch=main", "."], path);
	git(["config", "user.email", "t@t"], path);
	git(["config", "user.name", "t"], path);
	writeFileSync(join(path, "base.txt"), "1\n2\n3\n");
	git(["add", "-A", "."], path);
	git(["commit", "-q", "-m", "feat: init"], path);
	return { path, git: createGitRunner({}) };
}

function throwingGh(): GhRunner {
	return createGhRunner({
		exec: async () => {
			throw new Error("gh must not be called");
		},
	});
}

type ToolCall = { tool: string; params: unknown };

function pipeline(
	repo: { path: string; git: GitRunner },
	script: ToolCall[],
	options: {
		settings?: Partial<CommitPipelineDeps["settings"]>;
		analyzeRunner?: (paths: string[]) => Promise<string>;
		tempDir?: string;
		prompts?: string[];
	} = {},
): {
	deps: CommitPipelineDeps;
	run: (
		pipelineOptions?: CommitPipelineOptions,
	) => Promise<Awaited<ReturnType<typeof runCommitPipeline>>>;
} {
	const deps: CommitPipelineDeps = {
		git: repo.git,
		gh: throwingGh(),
		cwd: repo.path,
		settings: { ...COMMIT_DEFAULTS, ...(options.settings ?? {}) },
		...(options.tempDir ? { tempDir: options.tempDir } : {}),
		createNestedSession: async (factoryOptions: CreateAgentSessionOptions) => {
			const tools = factoryOptions.customTools ?? [];
			return {
				session: {
					prompt: async () => {
						if (options.prompts) options.prompts.push("prompt");
						for (const step of script) {
							const tool = tools.find(
								(candidate) => candidate.name === step.tool,
							);
							if (!tool) {
								throw new Error(`scripted tool missing: ${step.tool}`);
							}
							await tool.execute(
								"test-call",
								step.params as never,
								undefined,
								undefined,
								{} as never,
							);
						}
					},
					abort: () => {},
					getLastAssistantText: () => "",
					dispose: () => {},
				},
			};
		},
	};
	if (options.analyzeRunner) {
		deps.analyzeRunner = options.analyzeRunner;
	}
	return {
		deps,
		run: (pipelineOptions?: CommitPipelineOptions) =>
			runCommitPipeline(deps, pipelineOptions ?? {}),
	};
}

const propose = (files: string[], subject = "feat: do the thing") => ({
	tool: "propose_commit",
	params: { type: "feat", summary: subject.replace(/^feat: /, ""), files },
});

const proposeSplit = (
	commits: Array<{ type: string; summary: string; files: string[] }>,
) => ({
	tool: "propose_split_commit",
	params: { commits },
});

const settingsFor = (patch: Record<string, unknown>) => patch;

describe("single proposal execution (§77, §83)", () => {
	it("commits staged changes and proves it by HEAD movement", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const { run } = pipeline(repo, [propose(["a.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		const result = await run();
		expect(result.outcome).toBe("committed");
		expect(result.commits).toHaveLength(1);
		expect(git(["rev-parse", "HEAD"], repo.path).trim()).not.toBe(headBefore);
		expect(git(["log", "-1", "--format=%s"], repo.path).trim()).toBe(
			"feat: do the thing",
		);
		expect(git(["status", "--porcelain=v2"], repo.path).trim()).toBe("");
	});

	it("returns a no-staged-changes outcome for unstaged-only work", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "base.txt"), "1\n2\nunstaged\n");
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const indexBefore = git(["write-tree"], repo.path).trim();
		const { run } = pipeline(repo, [propose(["a.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		const result = await run({ push: true });
		expect(result.outcome).toBe("no-staged-changes");
		expect(result.text).toMatch(/--all/);
		// HEAD/index invariance: nothing staged, nothing committed.
		expect(git(["rev-parse", "HEAD"], repo.path).trim()).toBe(headBefore);
		expect(git(["write-tree"], repo.path).trim()).toBe(indexBefore);
		expect(git(["status", "--porcelain=v2"], repo.path)).toMatch(/^1 \.M /m);
		// No unintended push: even --push must not push without staged changes.
		expect(result.push).toBeUndefined();
	});

	it("returns a no-staged-changes outcome when only untracked files exist", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "new.txt"), "fresh\n");
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const { run } = pipeline(repo, [propose(["new.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		const result = await run();
		expect(result.outcome).toBe("no-staged-changes");
		expect(result.text).toMatch(/--all/);
		expect(git(["rev-parse", "HEAD"], repo.path).trim()).toBe(headBefore);
		expect(git(["status", "--porcelain=v2"], repo.path)).toMatch(
			/^\? new\.txt$/m,
		);
		// The untracked file was never staged.
		expect(git(["ls-files", "--", "new.txt"], repo.path).trim()).toBe("");
	});

	it("commits only the staged set and leaves unrelated unstaged work alone", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		writeFileSync(join(repo.path, "base.txt"), "1\n2\nunrelated\n");
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const { run } = pipeline(repo, [propose(["a.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		const result = await run();
		expect(result.outcome).toBe("committed");
		expect(git(["rev-parse", "HEAD"], repo.path).trim()).not.toBe(headBefore);
		const committed = git(
			["show", "--name-only", "--format=", "HEAD"],
			repo.path,
		);
		expect(committed).toContain("a.txt");
		expect(committed).not.toContain("base.txt");
		// The unrelated change is still there, still unstaged.
		expect(git(["status", "--porcelain=v2"], repo.path)).toMatch(/^1 \.M /m);
	});

	it("commits the staged content of a partially staged file and keeps the rest unstaged", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "base.txt"), "1\n2\n3\nstaged\n");
		git(["add", "base.txt"], repo.path);
		writeFileSync(join(repo.path, "base.txt"), "1\n2\n3\nstaged\nworktree\n");
		const { run } = pipeline(repo, [propose(["base.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		const result = await run();
		expect(result.outcome).toBe("committed");
		const headContent = git(["show", "HEAD:base.txt"], repo.path);
		expect(headContent).toContain("staged");
		expect(headContent).not.toContain("worktree");
		expect(git(["status", "--porcelain=v2"], repo.path)).toMatch(/^1 \.M /m);
	});

	it("returns a definitive no-changes outcome on a clean tree", async () => {
		const repo = initRepo();
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const { run } = pipeline(repo, [propose(["base.txt"])]);
		const result = await run();
		expect(result.outcome).toBe("no-changes");
		expect(result.text).toContain("Nothing to commit");
		expect(git(["rev-parse", "HEAD"], repo.path).trim()).toBe(headBefore);
	});

	it("fails clearly when the agent proposes nothing", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		const { run } = pipeline(repo, []);
		await expect(run()).rejects.toThrow(/did not propose a commit plan/);
		expect(git(["status", "--porcelain=v2"], repo.path)).toContain("1 A. ");
	});

	it("rejects proposals referencing unknown or uncovered files", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		const { run } = pipeline(repo, [
			{
				tool: "propose_commit",
				params: { type: "feat", summary: "x", files: ["ghost.txt"] },
			},
		]);
		await expect(run()).rejects.toThrow(/not part of the changes/);

		const { run: run2 } = pipeline(repo, [
			{
				tool: "propose_commit",
				params: { type: "feat", summary: "x", files: [] },
			},
		]);
		await expect(run2()).rejects.toThrow(
			/does not cover|lists no files|no file list/,
		);
	});
});

describe("dry run (§82, D1)", () => {
	// The operating view for a dry run is the staged set (staged-only
	// default); a dirty tree with nothing staged is guidance, not a plan.
	it("prints the staged-only plan and mutates neither index nor working tree", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		const { run } = pipeline(repo, [propose(["a.txt"])]);
		const result = await run({ dryRun: true });
		expect(result.outcome).toBe("dry-run");
		expect(result.plan).toContain("feat: do the thing");
		expect(result.plan).toContain("- a.txt");
		// Still staged, not committed: HEAD/index invariance.
		expect(git(["status", "--porcelain=v2"], repo.path)).toMatch(/^1 [AM]\. /m);
		expect(git(["stash", "list"], repo.path).trim()).toBe("");
	});

	it("returns no-staged-changes guidance in dry-run when nothing is staged", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "brand-new.txt"), "fresh\n");
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const indexBefore = git(["write-tree"], repo.path).trim();
		const { run } = pipeline(repo, [propose(["brand-new.txt"])]);
		const result = await run({ dryRun: true });
		expect(result.outcome).toBe("no-staged-changes");
		expect(result.text).toMatch(/--all/);
		// Dry-run invariance: nothing staged, committed, or mutated.
		expect(git(["rev-parse", "HEAD"], repo.path).trim()).toBe(headBefore);
		expect(git(["write-tree"], repo.path).trim()).toBe(indexBefore);
		expect(git(["status", "--porcelain=v2"], repo.path)).toMatch(
			/^\? brand-new\.txt$/m,
		);
	});

	it("never pushes in dry-run", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		const { run } = pipeline(repo, [propose(["a.txt"])]);
		const result = await run({ dryRun: true, push: true });
		expect(result.outcome).toBe("dry-run");
		expect(result.push).toBeUndefined();
	});
});

describe("split execution (§78–§80)", () => {
	it("creates coherent commits covering every changed file", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		writeFileSync(join(repo.path, "b.txt"), "other\n");
		git(["add", "-A", "."], repo.path);
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const { run } = pipeline(
			repo,
			[
				proposeSplit([
					{ type: "feat", summary: "first concern", files: ["a.txt"] },
					{ type: "fix", summary: "second concern", files: ["b.txt"] },
				]),
			],
			{ settings: settingsFor({ splitPolicy: "auto" }) },
		);
		const result = await run();
		// §100: structural invariants only — N coherent commits covering
		// every changed file; the model's grouping is not asserted.
		expect(result.commits.length).toBe(2);
		const names = git(
			["log", "--format=", "--name-only", `${headBefore}..HEAD`],
			repo.path,
		)
			.split("\n")
			.filter((line) => line.trim());
		expect(new Set(names)).toEqual(new Set(["a.txt", "b.txt"]));
		expect(git(["status", "--porcelain=v2"], repo.path).trim()).toBe("");
	});

	it("stops at a failing commit, reports progress, and keeps changes recoverable", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		writeFileSync(join(repo.path, "b.txt"), "other\n");
		git(["add", "-A", "."], repo.path);
		const hooks = join(repo.path, ".git", "hooks");
		// Reject any commit whose message mentions the second concern.
		writeFileSync(
			join(hooks, "commit-msg"),
			"#!/bin/sh\ngrep -q 'second concern' \"$1\" && { echo 'msg rejected by policy' >&2; exit 1; }\nexit 0\n",
		);
		execFileSync("chmod", ["+x", join(hooks, "commit-msg")]);
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const { run } = pipeline(
			repo,
			[
				proposeSplit([
					{ type: "feat", summary: "first concern", files: ["a.txt"] },
					{ type: "fix", summary: "second concern", files: ["b.txt"] },
				]),
			],
			{ settings: settingsFor({ splitPolicy: "auto" }) },
		);
		await expect(run()).rejects.toThrow(/msg rejected by policy/);
		// First commit succeeded; second did not.
		const log = git(["log", "--format=%s", `${headBefore}..HEAD`], repo.path);
		expect(log).toContain("first concern");
		expect(log).not.toContain("second concern");
		// Uncommitted changes remain recoverable (index restored).
		const status = git(["status", "--porcelain=v2"], repo.path);
		expect(status).toContain("b.txt");
	});

	it("honors splitPolicy never by collapsing to one commit", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		writeFileSync(join(repo.path, "b.txt"), "other\n");
		git(["add", "-A", "."], repo.path);
		const { run } = pipeline(
			repo,
			[
				proposeSplit([
					{ type: "feat", summary: "first concern", files: ["a.txt"] },
					{ type: "fix", summary: "second concern", files: ["b.txt"] },
				]),
			],
			{ settings: settingsFor({ splitPolicy: "never" }) },
		);
		const result = await run();
		expect(result.commits).toHaveLength(1);
		expect(result.commits[0]?.files).toEqual(["a.txt", "b.txt"]);
	});

	it("requires explicit confirmation for split plans under policy confirm", async () => {
		const stagedSplitRepo = () => {
			const repo = initRepo();
			writeFileSync(join(repo.path, "a.txt"), "change\n");
			writeFileSync(join(repo.path, "b.txt"), "other\n");
			git(["add", "-A", "."], repo.path);
			return repo;
		};
		const splitScript = [
			proposeSplit([
				{ type: "feat", summary: "first", files: ["a.txt"] },
				{ type: "fix", summary: "second", files: ["b.txt"] },
			]),
		];
		// No confirmation path: explicit error, nothing committed.
		const first = stagedSplitRepo();
		const { run } = pipeline(first, splitScript, {
			settings: settingsFor({ splitPolicy: "confirm" }),
		});
		await expect(run()).rejects.toThrow(/splitPolicy is 'confirm'/);
		expect(git(["status", "--porcelain=v2"], first.path)).toContain("1 A. ");
		// With a confirmation path: approval applies the plan.
		const second = stagedSplitRepo();
		const { run: runApproved } = pipeline(second, splitScript, {
			settings: settingsFor({ splitPolicy: "confirm" }),
		});
		const result = await runApproved({ confirmPlan: async () => true });
		expect(result.outcome).toBe("committed");
		expect(result.commits).toHaveLength(2);
		// Rejection commits nothing.
		const third = stagedSplitRepo();
		const { run: runDenied } = pipeline(third, splitScript, {
			settings: settingsFor({ splitPolicy: "confirm" }),
		});
		await expect(runDenied({ confirmPlan: async () => false })).rejects.toThrow(
			/not approved/,
		);
	});

	it("aborts on a conservation mismatch (hook side-effects)", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		const hooks = join(repo.path, ".git", "hooks");
		// The hook modifies an unrelated tracked file behind the pipeline's back.
		writeFileSync(
			join(hooks, "post-commit"),
			"#!/bin/sh\nprintf 'tampered\\n' >> base.txt\nexit 0\n",
		);
		execFileSync("chmod", ["+x", join(hooks, "post-commit")]);
		const { run } = pipeline(repo, [propose(["a.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		await expect(run()).rejects.toThrow(/Tree conservation check failed/);
	});
});

describe("hooks and signing (§84–§85)", () => {
	it("preserves pre-commit stderr and names the failed step", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		const hooks = join(repo.path, ".git", "hooks");
		writeFileSync(
			join(hooks, "pre-commit"),
			"#!/bin/sh\necho 'lint failure' >&2\nexit 1\n",
		);
		execFileSync("chmod", ["+x", join(hooks, "pre-commit")]);
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const { run } = pipeline(repo, [propose(["a.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		await expect(run()).rejects.toThrow(/lint failure/);
		expect(git(["rev-parse", "HEAD"], repo.path).trim()).toBe(headBefore);
	});
});

describe("analyze_files policy (§76, D5)", () => {
	it("fans out within the configured cap and concurrency", async () => {
		const repo = initRepo();
		for (let index = 0; index < 3; index += 1) {
			writeFileSync(join(repo.path, `f${index}.txt`), `content ${index}\n`);
		}
		git(["add", "-A", "."], repo.path);
		const analyzed: string[] = [];
		const { run } = pipeline(
			repo,
			[
				{
					tool: "analyze_files",
					params: { paths: ["f0.txt", "f1.txt", "f2.txt"] },
				},
				propose(["f0.txt", "f1.txt", "f2.txt"]),
			],
			{
				settings: settingsFor({ splitPolicy: "auto", analyzeFilesMaxFiles: 8 }),
				analyzeRunner: async (paths) => {
					analyzed.push(...paths);
					return paths.map((path) => `${path}: intent`).join("\n");
				},
			},
		);
		const result = await run();
		expect(result.outcome).toBe("committed");
		expect(analyzed).toEqual(["f0.txt", "f1.txt", "f2.txt"]);
	});

	it("caps per-call file counts and can be disabled", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		writeFileSync(join(repo.path, "base.txt"), "1\n2\nchanged\n");
		git(["add", "-A", "."], repo.path);
		// Tool policy errors are results the agent sees, not pipeline failures.
		const results: string[] = [];
		const recordTool = (tool: string, params: unknown): ToolCall => ({
			tool,
			params,
		});
		void recordTool;
		const { deps, run } = pipeline(
			repo,
			[
				{
					tool: "analyze_files",
					params: { paths: ["a.txt", "base.txt"] },
				},
				propose(["a.txt", "base.txt"]),
			],
			{
				settings: settingsFor({ splitPolicy: "auto", analyzeFilesMaxFiles: 1 }),
				analyzeRunner: async () => "should not run",
			},
		);
		// Capture what the tool returns by wrapping createNestedSession.
		const originalFactory = deps.createNestedSession;
		if (!originalFactory) throw new Error("factory missing");
		deps.createNestedSession = async (factoryOptions) => {
			const session = await originalFactory(factoryOptions);
			const tools = factoryOptions.customTools ?? [];
			const analyzeTool = tools.find(
				(candidate) => candidate.name === "analyze_files",
			);
			if (analyzeTool) {
				const result = await analyzeTool.execute(
					"id",
					{ paths: ["a.txt", "base.txt"] } as never,
					undefined,
					undefined,
					{} as never,
				);
				results.push(
					result.content
						.map((part) => ("text" in part ? part.text : ""))
						.join(""),
				);
			}
			return session;
		};
		const result = await run();
		expect(result.outcome).toBe("committed");
		expect(results[0]).toContain("capped at 1 files");

		const disabled: string[] = [];
		const repo2 = initRepo();
		writeFileSync(join(repo2.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo2.path);
		const { deps: deps2, run: runDisabled } = pipeline(
			repo2,
			[propose(["a.txt"])],
			{
				settings: settingsFor({
					splitPolicy: "auto",
					analyzeFilesEnabled: false,
				}),
				analyzeRunner: async () => "should not run",
			},
		);
		const originalFactory2 = deps2.createNestedSession;
		if (!originalFactory2) throw new Error("factory missing");
		deps2.createNestedSession = async (factoryOptions) => {
			const session = await originalFactory2(factoryOptions);
			const tools = factoryOptions.customTools ?? [];
			const analyzeTool = tools.find(
				(candidate) => candidate.name === "analyze_files",
			);
			if (analyzeTool) {
				const result = await analyzeTool.execute(
					"id",
					{ paths: ["a.txt"] } as never,
					undefined,
					undefined,
					{} as never,
				);
				disabled.push(
					result.content
						.map((part) => ("text" in part ? part.text : ""))
						.join(""),
				);
			}
			return session;
		};
		await runDisabled();
		expect(disabled[0]).toContain("disabled by configuration");
	});

	it("skips expensive analysis in dry-run by default", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		const { run } = pipeline(
			repo,
			[
				{ tool: "analyze_files", params: { paths: ["a.txt"] } },
				propose(["a.txt"]),
			],
			{ analyzeRunner: async () => "should not run" },
		);
		const result = await run({ dryRun: true });
		expect(result.outcome).toBe("dry-run");
	});
});

describe("changelog integration (§81)", () => {
	it("commits the changelog entry within the first commit", async () => {
		const repo = initRepo();
		writeFileSync(
			join(repo.path, "CHANGELOG.md"),
			"# Changelog\n\n## 1.0.0\n\n- initial\n",
		);
		git(["add", "CHANGELOG.md"], repo.path);
		git(["commit", "-qm", "docs: changelog"], repo.path);
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		const { run } = pipeline(repo, [propose(["a.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		const result = await run();
		expect(result.outcome).toBe("committed");
		expect(result.text).toContain("Changelog updated: CHANGELOG.md");
		const changelog = readFileSync(join(repo.path, "CHANGELOG.md"), "utf8");
		expect(changelog).toContain("## Unreleased");
		expect(changelog).toContain("- feat: do the thing");
		// The changelog edit is part of the commit, not a hidden mutation.
		const committed = git(
			["show", "--name-only", "--format=", "HEAD"],
			repo.path,
		);
		expect(committed).toContain("CHANGELOG.md");
		expect(committed).toContain("a.txt");
	});

	it("skips the changelog with --no-changelog or when absent", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		const { run } = pipeline(repo, [propose(["a.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		const result = await run({ noChangelog: true });
		expect(result.text).not.toContain("Changelog updated");
		// Missing changelog is not an error.
		const repo2 = initRepo();
		writeFileSync(join(repo2.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo2.path);
		const { run: run2 } = pipeline(repo2, [propose(["a.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		const result2 = await run2();
		expect(result2.outcome).toBe("committed");
	});
});

describe("--push (§86)", () => {
	function withUpstream(): { repo: ReturnType<typeof initRepo>; bare: string } {
		const repo = initRepo();
		const bare = mkdtempSync(join(tmpdir(), "pi-omp-git-remote-"));
		tempDirs.push(bare);
		execFileSync("git", ["init", "-q", "--bare", bare], {
			env: { ...process.env },
		});
		git(["remote", "add", "origin", bare], repo.path);
		git(["push", "-q", "-u", "origin", "main"], repo.path);
		return { repo, bare };
	}

	it("pushes after commits succeed and never before", async () => {
		const { repo } = withUpstream();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		const { run } = pipeline(repo, [propose(["a.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		const result = await run({ push: true });
		expect(result.outcome).toBe("committed");
		expect(result.push?.pushed).toBe(true);
		expect(result.push?.report).toContain("Pushed main to origin");
		const remoteUrl = git(["remote", "get-url", "origin"], repo.path).trim();
		const remoteHead = git(["rev-parse", "main"], remoteUrl).trim();
		expect(remoteHead).toBe(git(["rev-parse", "HEAD"], repo.path).trim());
	});

	it("surfaces push rejection as an error, never a force push", async () => {
		const { repo, bare } = withUpstream();
		// Diverge the remote so the push is rejected (non-fast-forward).
		const diverge = mkdtempSync(join(tmpdir(), "pi-omp-git-diverge-"));
		tempDirs.push(diverge);
		execFileSync("git", ["init", "-q", diverge], {
			env: { ...process.env },
		});
		git(["config", "user.email", "t@t"], diverge);
		git(["config", "user.name", "t"], diverge);
		writeFileSync(join(diverge, "x.txt"), "divergent\n");
		git(["add", "-A", "."], diverge);
		git(["commit", "-qm", "diverge"], diverge);
		// Force the diverged history into place (test setup); the pipeline's
		// own push below must never force.
		git(["push", "-q", "--force", bare, "HEAD:refs/heads/main"], diverge);
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		const { run } = pipeline(repo, [propose(["a.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		await expect(run({ push: true })).rejects.toThrow(/rejected/i);
		// The remote tip is unchanged — no force push happened.
		const remoteTip = git(["rev-parse", "main"], bare).trim();
		const divergedTip = git(["rev-parse", "HEAD"], diverge).trim();
		expect(remoteTip).toBe(divergedTip);
	});

	it("pushes existing local commits on a clean tree, or reports why not", async () => {
		const { repo } = withUpstream();
		// A local commit ahead of the upstream.
		git(["commit", "-q", "--allow-empty", "-m", "feat: local work"], repo.path);
		const { run } = pipeline(repo, [propose(["a.txt"])]);
		const result = await run({ push: true });
		expect(result.outcome).toBe("no-changes");
		expect(result.push?.pushed).toBe(true);
		// Everything pushed: a second run reports nothing to push.
		const { run: run2 } = pipeline(repo, [propose(["a.txt"])]);
		const result2 = await run2({ push: true });
		expect(result2.push?.pushed).toBe(false);
		expect(result2.push?.report).toContain("no unpushed commits");
	});

	it("routes PR-branch pushes through the PR push path", async () => {
		const repo = initRepo();
		const bare = mkdtempSync(join(tmpdir(), "pi-omp-git-prremote-"));
		tempDirs.push(bare);
		execFileSync("git", ["init", "-q", "--bare", bare], {
			env: { ...process.env },
		});
		git(["remote", "add", "origin", bare], repo.path);
		// OMP checkout metadata marks this as a PR branch.
		git(
			["config", "branch.main.ompPrUrl", "https://github.com/o/r/pull/7"],
			repo.path,
		);
		git(["config", "branch.main.ompPrHeadRef", "pr-7"], repo.path);
		git(["config", "branch.main.remote", "origin"], repo.path);
		git(["commit", "-q", "--allow-empty", "-m", "feat: pr work"], repo.path);
		// Publish the PR head ref so the push has a target.
		git(["push", "-q", "origin", "HEAD:refs/heads/pr-7"], repo.path);
		git(["commit", "-q", "--allow-empty", "-m", "feat: pr work 2"], repo.path);
		const { run } = pipeline(repo, [propose(["a.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		const result = await run({ push: true });
		expect(result.push?.pushed).toBe(true);
		// The PR push path pushed to the PR head ref, not main.
		const refs = git(["show-ref"], bare);
		expect(refs).toContain("refs/heads/pr-7");
	});
});

describe("--all explicit staging", () => {
	it("stages and commits the full change set: staged, unstaged, and untracked", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "staged new\n");
		git(["add", "a.txt"], repo.path);
		writeFileSync(join(repo.path, "base.txt"), "1\n2\nunstaged\n");
		writeFileSync(join(repo.path, "new.txt"), "untracked\n");
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const { run } = pipeline(
			repo,
			[propose(["a.txt", "base.txt", "new.txt"])],
			{ settings: settingsFor({ splitPolicy: "auto" }) },
		);
		const result = await run({ all: true });
		expect(result.outcome).toBe("committed");
		expect(git(["rev-parse", "HEAD"], repo.path).trim()).not.toBe(headBefore);
		const committed = git(
			["show", "--name-only", "--format=", "HEAD"],
			repo.path,
		);
		expect(committed).toContain("a.txt");
		expect(committed).toContain("base.txt");
		expect(committed).toContain("new.txt");
		expect(git(["status", "--porcelain=v2"], repo.path).trim()).toBe("");
	});

	it("stages deletions and untracked files with --all", async () => {
		const repo = initRepo();
		rmSync(join(repo.path, "base.txt"));
		writeFileSync(join(repo.path, "new.txt"), "fresh\n");
		const { run } = pipeline(repo, [propose(["base.txt", "new.txt"])], {
			settings: settingsFor({ splitPolicy: "auto" }),
		});
		const result = await run({ all: true });
		expect(result.outcome).toBe("committed");
		const changes = git(
			["show", "--name-status", "--format=", "HEAD"],
			repo.path,
		);
		expect(changes).toContain("D\tbase.txt");
		expect(changes).toContain("A\tnew.txt");
		expect(git(["status", "--porcelain=v2"], repo.path).trim()).toBe("");
	});

	it("keeps the deterministic no-changes outcome for --all on a clean tree", async () => {
		const repo = initRepo();
		const { run } = pipeline(repo, [propose(["base.txt"])]);
		const result = await run({ all: true });
		expect(result.outcome).toBe("no-changes");
		expect(result.text).toContain("Nothing to commit");
	});

	it("previews the complete all-changes plan without mutating HEAD, index, or worktree", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "staged new\n");
		git(["add", "a.txt"], repo.path);
		writeFileSync(join(repo.path, "base.txt"), "1\n2\nunstaged\n");
		writeFileSync(join(repo.path, "new.txt"), "untracked\n");
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const indexBefore = git(["write-tree"], repo.path).trim();
		const statusBefore = git(["status", "--porcelain=v2"], repo.path);
		const { run } = pipeline(repo, [propose(["a.txt", "base.txt", "new.txt"])]);
		const result = await run({ dryRun: true, all: true });
		expect(result.outcome).toBe("dry-run");
		for (const path of ["a.txt", "base.txt", "new.txt"]) {
			expect(result.plan).toContain(`- ${path}`);
		}
		expect(git(["rev-parse", "HEAD"], repo.path).trim()).toBe(headBefore);
		expect(git(["write-tree"], repo.path).trim()).toBe(indexBefore);
		expect(git(["status", "--porcelain=v2"], repo.path)).toBe(statusBefore);
		expect(git(["stash", "list"], repo.path).trim()).toBe("");
	});

	it("includes untracked file contents in the all-changes preview diffs", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "brand-new.txt"), "untracked content\n");
		const { deps, run } = pipeline(repo, [propose(["brand-new.txt"])]);
		const originalFactory = deps.createNestedSession;
		if (!originalFactory) throw new Error("factory missing");
		const seen: string[] = [];
		deps.createNestedSession = async (factoryOptions) => {
			const session = await originalFactory(factoryOptions);
			const tools = factoryOptions.customTools ?? [];
			const diffTool = tools.find(
				(candidate) => candidate.name === "git_file_diff",
			);
			if (!diffTool) throw new Error("git_file_diff missing");
			const result = await diffTool.execute(
				"id",
				{ path: "brand-new.txt" } as never,
				undefined,
				undefined,
				{} as never,
			);
			seen.push(
				result.content
					.map((part) => ("text" in part ? part.text : ""))
					.join(""),
			);
			return session;
		};
		const result = await run({ dryRun: true, all: true });
		expect(result.outcome).toBe("dry-run");
		// The preview carries the untracked file's patch, not just its name.
		expect(seen.join("")).toContain("+untracked content");
		expect(git(["status", "--porcelain=v2"], repo.path)).toMatch(
			/^\? brand-new\.txt$/m,
		);
	});

	it("keeps the caller's index intact when the proposal is invalid with --all", async () => {
		const repo = initRepo();
		// Partially staged: staged content differs from the worktree.
		writeFileSync(join(repo.path, "base.txt"), "1\n2\n3\nstaged\n");
		git(["add", "base.txt"], repo.path);
		writeFileSync(join(repo.path, "base.txt"), "1\n2\n3\nstaged\nworktree\n");
		writeFileSync(join(repo.path, "a.txt"), "new\n");
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const indexBefore = git(["write-tree"], repo.path).trim();
		const statusBefore = git(["status", "--porcelain=v2"], repo.path);
		const { run } = pipeline(repo, [
			{
				tool: "propose_commit",
				params: { type: "feat", summary: "x", files: ["ghost.txt"] },
			},
		]);
		await expect(run({ all: true })).rejects.toThrow(/not part of the changes/);
		// A failed proposal must not stage anything.
		expect(git(["rev-parse", "HEAD"], repo.path).trim()).toBe(headBefore);
		expect(git(["write-tree"], repo.path).trim()).toBe(indexBefore);
		expect(git(["status", "--porcelain=v2"], repo.path)).toBe(statusBefore);
	});

	it("keeps the caller's index intact when the agent proposes nothing with --all", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "change\n");
		git(["add", "a.txt"], repo.path);
		const indexBefore = git(["write-tree"], repo.path).trim();
		const { run } = pipeline(repo, []);
		await expect(run({ all: true })).rejects.toThrow(
			/did not propose a commit plan/,
		);
		expect(git(["write-tree"], repo.path).trim()).toBe(indexBefore);
		expect(git(["status", "--porcelain=v2"], repo.path)).toMatch(/^1 A\. /m);
	});

	it("aborts when the working tree changes between the plan and the real staging", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "one\n");
		git(["add", "a.txt"], repo.path);
		writeFileSync(join(repo.path, "b.txt"), "two\n");
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const indexBefore = git(["write-tree"], repo.path).trim();
		const { run } = pipeline(
			repo,
			[
				proposeSplit([
					{ type: "feat", summary: "first", files: ["a.txt"] },
					{ type: "fix", summary: "second", files: ["b.txt"] },
				]),
			],
			{ settings: settingsFor({ splitPolicy: "confirm" }) },
		);
		await expect(
			run({
				all: true,
				confirmPlan: async () => {
					// Concurrent worktree modification after the plan was made.
					writeFileSync(join(repo.path, "b.txt"), "two\nchanged\n");
					return true;
				},
			}),
		).rejects.toThrow(
			/working tree changed while the commit was being planned/,
		);
		// Nothing was staged or committed.
		expect(git(["rev-parse", "HEAD"], repo.path).trim()).toBe(headBefore);
		expect(git(["write-tree"], repo.path).trim()).toBe(indexBefore);
		const status = git(["status", "--porcelain=v2"], repo.path);
		expect(status).toMatch(/^1 A\. /m);
		expect(status).toMatch(/^\? b\.txt$/m);
	});

	it("aborts when the index changes between the plan and the real staging", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "a.txt"), "one\n");
		git(["add", "a.txt"], repo.path);
		writeFileSync(join(repo.path, "c.txt"), "planned\n");
		writeFileSync(join(repo.path, "e.txt"), "concurrent\n");
		const headBefore = git(["rev-parse", "HEAD"], repo.path).trim();
		const { run } = pipeline(
			repo,
			[
				proposeSplit([
					{ type: "feat", summary: "first", files: ["a.txt", "c.txt"] },
					{ type: "fix", summary: "second", files: ["e.txt"] },
				]),
			],
			{ settings: settingsFor({ splitPolicy: "confirm" }) },
		);
		await expect(
			run({
				all: true,
				confirmPlan: async () => {
					// Concurrent staging of an unplanned file after approval.
					execFileSync("git", ["add", "c.txt"], {
						cwd: repo.path,
						stdio: "ignore",
					});
					return true;
				},
			}),
		).rejects.toThrow(/index changed while the commit was being planned/);
		expect(git(["rev-parse", "HEAD"], repo.path).trim()).toBe(headBefore);
		const status = git(["status", "--porcelain=v2"], repo.path);
		// Only the caller's own staging happened; the pipeline added nothing.
		expect(status).toMatch(/^1 A\. /m);
		expect(git(["ls-files", "--", "c.txt"], repo.path).trim()).not.toBe("");
	});
});

describe("argument parsing (§73)", () => {
	it("parses /commit flags from raw input through the shared parser", async () => {
		const { parseCommitArgs } = await import("../src/index.ts");
		const parsed = parseCommitArgs(
			`--dry-run --push --no-changelog --context "release notes" --model gpt-5`,
		);
		expect(parsed.dryRun).toBe(true);
		expect(parsed.push).toBe(true);
		expect(parsed.noChangelog).toBe(true);
		expect(parsed.context).toBe("release notes");
		expect(parsed.model).toBe("gpt-5");
	});

	it("rejects invalid input before the pipeline runs", async () => {
		const { parseCommitArgs } = await import("../src/index.ts");
		expect(() => parseCommitArgs("--unknown")).toThrow(/unknown/i);
		expect(() => parseCommitArgs("release notes")).toThrow(/unexpected/i);
		expect(() => parseCommitArgs("--model")).toThrow(/model/i);
	});
});
