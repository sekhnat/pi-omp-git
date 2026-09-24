/**
 * Ticket 20 acceptance tests: AI Stage (§70–§71) — nested-agent planning
 * with a proposal tool, explicit confirmation, index snapshot/verify/
 * restore safety, and file-level decisions for binary changes — driven
 * by deterministic scripted nested-agent responses over real git.
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
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AiStageDeps,
	applyAiStage,
	planAiStage,
	snapshotIndex,
} from "../src/git/ai-stage.ts";
import { createGitRunner, type GitRunner } from "../src/git/runner.ts";
import {
	buildGitUiState,
	collectGitRawStatus,
} from "../src/git/status-model.ts";
import { GitTuiComponent, GitTuiController } from "../src/git/tui.ts";

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
	const path = mkdtempSync(join(tmpdir(), "pi-omp-git-ai-"));
	tempDirs.push(path);
	git(["init", "-q", "--initial-branch=main", "."], path);
	git(["config", "user.email", "t@t"], path);
	git(["config", "user.name", "t"], path);
	writeFileSync(
		join(path, "retry.ts"),
		"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\n",
	);
	writeFileSync(
		join(path, "other.ts"),
		"1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n",
	);
	git(["add", "-A", "."], path);
	git(["commit", "-q", "-m", "init"], path);
	// Two independent changes: retry-related and unrelated.
	writeFileSync(
		join(path, "retry.ts"),
		"a\nRETRY_ONE\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\nRETRY_TWO\n",
	);
	writeFileSync(
		join(path, "other.ts"),
		"1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\nUNRELATED\n",
	);
	return { path, git: createGitRunner({}) };
}

async function stateFor(repo: { path: string; git: GitRunner }) {
	const raw = await collectGitRawStatus({ git: repo.git }, repo.path);
	return buildGitUiState(raw);
}

function deps(
	repo: { path: string; git: GitRunner },
	options: {
		plan?: { files: Array<{ path: string; hunks: number[] }> };
		prompts?: string[];
		toolParams?: unknown[];
	} = {},
): AiStageDeps {
	const factory = async (factoryOptions: CreateAgentSessionOptions) => ({
		session: {
			prompt: async () => {
				if (options.prompts) options.prompts.push("prompt");
				const tool = factoryOptions.customTools?.find(
					(candidate) => candidate.name === "propose_stage_plan",
				);
				if (tool && options.plan) {
					await tool.execute(
						"test-call",
						options.plan as never,
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
	});
	return {
		git: repo.git,
		cwd: repo.path,
		createNestedSession: factory,
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("AI stage planning (§70)", () => {
	it("produces a plan from the nested agent without staging anything", async () => {
		const repo = initRepo();
		const state = await stateFor(repo);
		const prompts: string[] = [];
		const stageDeps = deps(repo, {
			plan: { files: [{ path: "retry.ts", hunks: [0] }] },
			prompts,
		});
		const plan = await planAiStage(
			stageDeps,
			state,
			"stage the retry handling",
		);
		expect(plan.files).toEqual([{ path: "retry.ts", hunks: [0] }]);
		expect(prompts.length).toBe(1);
		// Read-only: nothing staged.
		expect(git(["status", "--porcelain=v2"], repo.path)).not.toContain("M. ");
	});

	it("rejects plans referencing unknown paths or out-of-range hunks", async () => {
		const repo = initRepo();
		const state = await stateFor(repo);
		await expect(
			planAiStage(
				deps(repo, { plan: { files: [{ path: "nope.ts", hunks: [] }] } }),
				state,
				"x",
			),
		).rejects.toThrow(/unknown path nope.ts/);
		await expect(
			planAiStage(
				deps(repo, { plan: { files: [{ path: "retry.ts", hunks: [7] }] } }),
				state,
				"x",
			),
		).rejects.toThrow(/hunk 7 of retry.ts, which does not exist/);
	});

	it("errors when the agent never proposes a plan", async () => {
		const repo = initRepo();
		const state = await stateFor(repo);
		await expect(
			planAiStage(deps(repo, {}), state, "stage something"),
		).rejects.toThrow(/did not propose a staging plan/);
	});

	it("forces file-level decisions for binary changes", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "blob.bin"), "\u0000one");
		git(["add", "blob.bin"], repo.path);
		git(["commit", "-qam", "bin"], repo.path);
		writeFileSync(join(repo.path, "blob.bin"), "\u0000two");
		const state = await stateFor(repo);
		// Binary hunk-level proposals are refused…
		await expect(
			planAiStage(
				deps(repo, { plan: { files: [{ path: "blob.bin", hunks: [0] }] } }),
				state,
				"x",
			),
		).rejects.toThrow(/file level/);
		// …and whole-file proposals validate.
		const plan = await planAiStage(
			deps(repo, { plan: { files: [{ path: "blob.bin", hunks: [] }] } }),
			state,
			"x",
		);
		expect(plan.files).toEqual([{ path: "blob.bin", hunks: [] }]);
	});
});

describe("AI stage application (§71)", () => {
	it("stages intended hunks and leaves unrelated changes untouched", async () => {
		const repo = initRepo();
		const state = await stateFor(repo);
		const outcome = await applyAiStage(
			deps(repo),
			state,
			{ files: [{ path: "retry.ts", hunks: [0] }] },
			{ confirmed: true },
		);
		expect(outcome.stagedFiles).toEqual(["retry.ts"]);
		expect(outcome.stagedHunks).toBe(1);
		const staged = git(["diff", "--cached", "--", "retry.ts"], repo.path);
		expect(staged).toContain("RETRY_ONE");
		expect(staged).not.toContain("RETRY_TWO");
		// Unrelated file untouched and still unstaged.
		const other = git(["diff", "--", "other.ts"], repo.path);
		expect(other).toContain("+UNRELATED");
		expect(git(["diff", "--cached", "--", "other.ts"], repo.path).trim()).toBe(
			"",
		);
		// The second retry hunk remains unstaged (rejected).
		const unstaged = git(["diff", "--", "retry.ts"], repo.path);
		expect(unstaged).toContain("+RETRY_TWO");
	});

	it("refuses to apply without explicit confirmation", async () => {
		const repo = initRepo();
		const state = await stateFor(repo);
		await expect(
			applyAiStage(
				deps(repo),
				state,
				{ files: [{ path: "retry.ts", hunks: [0] }] },
				{ confirmed: false },
			),
		).rejects.toThrow(/must be confirmed/);
		expect(git(["diff", "--cached"], repo.path).trim()).toBe("");
	});

	it("stages whole files when the plan says so", async () => {
		const repo = initRepo();
		const state = await stateFor(repo);
		const outcome = await applyAiStage(
			deps(repo),
			state,
			{ files: [{ path: "other.ts", hunks: [] }] },
			{ confirmed: true },
		);
		expect(outcome.stagedHunks).toBe(0);
		const staged = git(["diff", "--cached", "--", "other.ts"], repo.path);
		expect(staged).toContain("+UNRELATED");
		expect(git(["diff", "--", "other.ts"], repo.path).trim()).toBe("");
	});

	it("stages untracked files at whole-file and hunk level", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "new.txt"), "part1\npart2\n");
		const state = await stateFor(repo);
		await applyAiStage(
			deps(repo),
			state,
			{ files: [{ path: "new.txt", hunks: [] }] },
			{ confirmed: true },
		);
		expect(git(["status", "--porcelain=v2"], repo.path)).toContain("1 A. ");
		// Reset and stage via hunk-level plan (single hunk of a new file).
		git(["reset", "-q", "HEAD", "--", "new.txt"], repo.path);
		const state2 = await stateFor(repo);
		await applyAiStage(
			deps(repo),
			state2,
			{ files: [{ path: "new.txt", hunks: [0] }] },
			{ confirmed: true },
		);
		expect(git(["diff", "--cached", "--", "new.txt"], repo.path)).toContain(
			"+part1",
		);
	});

	it("restores the index snapshot when a halfway failure occurs", async () => {
		const repo = initRepo();
		writeFileSync(join(repo.path, "extra.txt"), "x\n");
		const state = await stateFor(repo);
		const snapshot = await snapshotIndex(deps(repo));
		// A plan whose second entry is stale (not in the unstaged set).
		await expect(
			applyAiStage(
				deps(repo),
				state,
				{
					files: [
						{ path: "retry.ts", hunks: [0] },
						{ path: "ghost.ts", hunks: [] },
					],
				},
				{ confirmed: true },
			),
		).rejects.toThrow(/no longer unstaged/);
		// The index must be back to the snapshot: nothing staged.
		const after = await snapshotIndex(deps(repo));
		expect(after).toBe(snapshot);
		expect(git(["diff", "--cached"], repo.path).trim()).toBe("");
		expect(existsSync(join(repo.path, "extra.txt"))).toBe(true);
	});

	it("loses no working-tree content as a side effect", async () => {
		const repo = initRepo();
		const before = readFileSync(join(repo.path, "retry.ts"), "utf8");
		const otherBefore = readFileSync(join(repo.path, "other.ts"), "utf8");
		const state = await stateFor(repo);
		await applyAiStage(
			deps(repo),
			state,
			{ files: [{ path: "retry.ts", hunks: [0] }] },
			{ confirmed: true },
		);
		expect(readFileSync(join(repo.path, "retry.ts"), "utf8")).toBe(before);
		expect(readFileSync(join(repo.path, "other.ts"), "utf8")).toBe(otherBefore);
		// Both working files still carry their full modified content.
		expect(before).toContain("RETRY_ONE");
		expect(before).toContain("RETRY_TWO");
		expect(otherBefore).toContain("UNRELATED");
	});
});

describe("AI stage in the TUI (§70)", () => {
	it("plans via the prompt, displays the plan, applies after y", async () => {
		const repo = initRepo();
		const state = await stateFor(repo);
		const controller = new GitTuiController(
			{
				...deps(repo, { plan: { files: [{ path: "retry.ts", hunks: [0] }] } }),
			},
			state,
		);
		const component = new GitTuiComponent(
			{ requestRender: () => {} },
			controller,
			() => {},
		);
		component.handleInput("a");
		expect(controller.aiPrompt).not.toBeNull();
		for (const char of "stage retry handling") controller.aiInsert(char);
		component.handleInput("\r");
		for (let spin = 0; spin < 100 && !controller.pendingAiPlan; spin += 1) {
			await sleep(20);
		}
		expect(controller.pendingAiPlan?.plan.files).toEqual([
			{ path: "retry.ts", hunks: [0] },
		]);
		// Nothing staged until confirmed.
		expect(git(["diff", "--cached"], repo.path).trim()).toBe("");
		component.handleInput("y");
		for (let spin = 0; spin < 100; spin += 1) {
			const staged = git(["diff", "--cached", "--", "retry.ts"], repo.path);
			if (staged.includes("RETRY_ONE") && controller.pendingAiPlan === null) {
				break;
			}
			await sleep(20);
		}
		expect(git(["diff", "--cached", "--", "retry.ts"], repo.path)).toContain(
			"RETRY_ONE",
		);
		expect(controller.pendingAiPlan).toBeNull();
	});

	it("cancels with n and leaves everything unstaged", async () => {
		const repo = initRepo();
		const state = await stateFor(repo);
		const controller = new GitTuiController(
			{ ...deps(repo, { plan: { files: [{ path: "retry.ts", hunks: [] }] } }) },
			state,
		);
		const component = new GitTuiComponent(
			{ requestRender: () => {} },
			controller,
			() => {},
		);
		component.handleInput("a");
		for (const char of "stage all retry") controller.aiInsert(char);
		component.handleInput("\r");
		for (let spin = 0; spin < 100 && !controller.pendingAiPlan; spin += 1) {
			await sleep(20);
		}
		component.handleInput("n");
		expect(controller.pendingAiPlan).toBeNull();
		expect(git(["diff", "--cached"], repo.path).trim()).toBe("");
	});

	it("renders the plan panel with per-file detail", async () => {
		const repo = initRepo();
		const state = await stateFor(repo);
		const controller = new GitTuiController(
			{
				...deps(repo, { plan: { files: [{ path: "retry.ts", hunks: [0] }] } }),
			},
			state,
		);
		const component = new GitTuiComponent(
			{ requestRender: () => {} },
			controller,
			() => {},
		);
		component.handleInput("a");
		for (const char of "stage retry") controller.aiInsert(char);
		component.handleInput("\r");
		for (let spin = 0; spin < 100 && !controller.pendingAiPlan; spin += 1) {
			await sleep(20);
		}
		controller.message = null;
		const text = (await import("../src/git/tui.ts"))
			.renderGitTui(controller, 100, 40)
			.join("\n");
		expect(text).toContain("AI staging plan (1 file(s))");
		expect(text).toContain("retry.ts — hunks 1");
		expect(text).toContain("[y] apply [n] cancel");
	});
});
