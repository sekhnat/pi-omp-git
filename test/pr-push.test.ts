/**
 * Ticket 13 acceptance tests: `pr_push` with last-checkout resolution
 * (docs/pi-omp-git-reference.md §§32–33, §96, §110).
 *
 * External behavior only: `gh` flows through the scripted fixture seam;
 * `git` runs for real in temporary repositories; the pushed ref is
 * verified against the remote repository itself.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../src/git/runner.ts";
import { createGitRunner } from "../src/git/runner.ts";
import type { GithubCache } from "../src/github/cache/cache.ts";
import { createGithubTool } from "../src/github/dispatcher.ts";
import type { CheckoutRecord } from "../src/github/last-checkout.ts";
import { createGhRunner } from "../src/github/runner.ts";

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

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
	}).trim();
}

function commitFile(repo: string, file: string, content: string): string {
	writeFileSync(join(repo, file), content);
	execFileSync("git", ["-C", repo, "add", file]);
	execFileSync("git", [
		"-C",
		repo,
		"commit",
		"-m",
		`add ${file}`,
		"--no-gpg-sign",
	]);
	return git(["rev-parse", "HEAD"], repo);
}

/** Recording fake for the cache (invalidation assertions). */
function fakeCache(): { cache: GithubCache; invalidated: string[] } {
	const invalidated: string[] = [];
	const cache = {
		readThrough: async () => ({ text: "", fromCache: false }),
		invalidate(identity: {
			kind: string;
			host: string;
			owner: string;
			repo: string;
			number: number;
			includeComments: boolean;
		}) {
			invalidated.push(
				`${identity.kind}:${identity.host}/${identity.owner}/${identity.repo}#${identity.number}:${identity.includeComments}`,
			);
		},
		invalidatePrRows(): void {
			invalidated.push("pr-rows");
		},
		invalidateIssueRows(): void {
			invalidated.push("issue-rows");
		},
		invalidateRepo(): void {
			invalidated.push("repo-rows");
		},
		flushBackground: async () => {},
	} as unknown as GithubCache;
	return { cache, invalidated };
}

function buildTool(options: { cwd: string; cache?: GithubCache }) {
	const calls: string[] = [];
	const exec = async (spec: { command: string; args: string[] }) => {
		calls.push([spec.command, ...spec.args].join(" "));
		throw new Error(
			`No gh fixture recorded for argv: ${[spec.command, ...spec.args].join(" ")}`,
		);
	};
	// Real git, wrapped only to record the argv (seam 2).
	const realGit = createGitRunner({});
	const gitCalls: string[][] = [];
	const gitProxy: GitRunner = {
		run(args, runOptions) {
			gitCalls.push([...args]);
			return realGit.run(args, runOptions);
		},
	};
	const tool = createGithubTool({
		gh: createGhRunner({ exec: exec as never }),
		git: gitProxy,
		availability: {
			gh: async () => ({ ok: true as const }),
			git: async () => ({ ok: true as const }),
			reset: (): void => {},
			ensureGh: async (): Promise<void> => {},
			ensureGit: async (): Promise<void> => {},
		} as never,
		env: { GH_TOKEN: "test-token" },
		cache: options.cache,
	});
	return { tool, calls, gitCalls };
}

async function call(
	tool: ReturnType<typeof createGithubTool>,
	params: Record<string, unknown>,
	cwd: string,
	getLastCheckout?: () => CheckoutRecord | null,
): Promise<AgentToolResult<unknown>> {
	// The dispatcher reads last-checkout resolution from the tool context.
	return tool.execute("id", params as never, undefined, undefined, {
		cwd,
		...(getLastCheckout ? { getLastCheckout } : {}),
	} as never);
}

function resultText(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

interface Scenario {
	origin: string;
	work: string;
	branchTip: string;
}

/**
 * A primary checkout with a prepared PR branch `pr-7` (full OMP metadata)
 * whose PR head branch `feature-7` exists on the remote at the merge
 * base, so a non-forced push is a fast-forward.
 */
function seedPushScenario(): Scenario {
	const originBare = join(tempDir("pi-omp-git-push-"), "origin.git");
	execFileSync("git", ["init", "--bare", "-b", "main", originBare]);

	const seedClone = `${tempDir("pi-omp-git-seed-")}/seed`;
	execFileSync("git", ["clone", originBare, seedClone], { cwd: tempDir("p") });
	git(["config", "user.email", "a@e.com"], seedClone);
	git(["config", "user.name", "A"], seedClone);
	commitFile(seedClone, "README.md", "# repo\n");
	execFileSync("git", [
		"-C",
		seedClone,
		"push",
		"origin",
		"HEAD:refs/heads/main",
	]);
	const baseSha = git(["rev-parse", "HEAD"], seedClone);
	// The remote PR head branch exists at the base (push fast-forwards it).
	execFileSync("git", [
		"-C",
		seedClone,
		"push",
		"origin",
		`${baseSha}:refs/heads/feature-7`,
	]);

	const work = `${tempDir("pi-omp-git-work-")}/primary`;
	execFileSync("git", ["clone", originBare, work], { cwd: tempDir("p") });
	git(["config", "user.email", "agent@example.com"], work);
	git(["config", "user.name", "Agent"], work);
	// The prepared local PR branch with one commit ahead of the remote head.
	execFileSync("git", ["-C", work, "checkout", "-b", "pr-7", "origin/main"]);
	const branchTip = commitFile(work, "change.txt", "x\n");
	for (const [key, value] of [
		["remote", "origin"],
		["merge", "refs/heads/feature-7"],
		["pushRemote", "origin"],
		["ompPrHeadRef", "feature-7"],
		["ompPrUrl", "https://github.com/owner/repo/pull/7"],
		["ompPrIsCrossRepository", "false"],
		["ompPrMaintainerCanModify", "false"],
	] as const) {
		execFileSync("git", ["-C", work, "config", `branch.pr-7.${key}`, value]);
	}
	return { origin: originBare, work, branchTip };
}

describe("pr_push", () => {
	it("pushes a non-current PR branch exactly to the PR head ref", async () => {
		const scenario = seedPushScenario();
		const { tool } = buildTool({ cwd: scenario.work });
		const result = await call(
			tool,
			{ op: "pr_push", branch: "pr-7" },
			scenario.work,
		);
		// The pushed ref is exactly refs/heads/<PR head ref>.
		expect(git(["rev-parse", "refs/heads/feature-7"], scenario.origin)).toBe(
			scenario.branchTip,
		);
		expect(resultText(result)).toContain("refs/heads/feature-7");
	});

	it("pushes from HEAD when the PR branch is checked out", async () => {
		const scenario = seedPushScenario();
		execFileSync("git", ["-C", scenario.work, "checkout", "pr-7"]);
		const { tool } = buildTool({ cwd: scenario.work });
		const result = await call(
			tool,
			{ op: "pr_push", branch: "pr-7" },
			scenario.work,
		);
		expect(resultText(result)).toContain("HEAD:refs/heads/feature-7");
		expect(git(["rev-parse", "refs/heads/feature-7"], scenario.origin)).toBe(
			scenario.branchTip,
		);
	});

	it("resolves the target by explicit pr text and PR URL", async () => {
		const scenario = seedPushScenario();
		const { tool } = buildTool({ cwd: scenario.work });
		for (const pr of ["7", "https://github.com/owner/repo/pull/7"]) {
			const result = await call(tool, { op: "pr_push", pr }, scenario.work);
			expect(resultText(result)).toContain("pr-7");
		}
	});

	it("resolves the target by the session's last checkout", async () => {
		const scenario = seedPushScenario();
		const { tool } = buildTool({ cwd: scenario.work });
		const result = await call(
			tool,
			{ op: "pr_push" },
			scenario.work,
			() =>
				({
					pr: "7",
					number: 7,
					branch: "pr-7",
					worktreePath: "/somewhere/pr-7",
				}) as CheckoutRecord,
		);
		expect(resultText(result)).toContain("last-checkout");
		expect(git(["rev-parse", "refs/heads/feature-7"], scenario.origin)).toBe(
			scenario.branchTip,
		);
	});

	it("resolves the target by current-branch metadata when nothing explicit remains", async () => {
		const scenario = seedPushScenario();
		execFileSync("git", ["-C", scenario.work, "checkout", "pr-7"]);
		const { tool } = buildTool({ cwd: scenario.work });
		const result = await call(tool, { op: "pr_push" }, scenario.work);
		expect(resultText(result)).toContain("current-branch");
	});

	it("yields the deterministic metadata error and never guesses a contributor branch", async () => {
		const scenario = seedPushScenario();
		// A branch without PR checkout metadata.
		execFileSync("git", [
			"-C",
			scenario.work,
			"branch",
			"some-feature",
			"origin/main",
		]);
		const { tool } = buildTool({ cwd: scenario.work });
		await expect(
			call(tool, { op: "pr_push", branch: "some-feature" }, scenario.work),
		).rejects.toThrow(
			/has no PR checkout metadata[\s\S]*Use pr_checkout before pr_push/s,
		);
	});

	it("rejects the array form of pr (single PR only)", async () => {
		const scenario = seedPushScenario();
		const { tool } = buildTool({ cwd: scenario.work });
		await expect(
			call(tool, { op: "pr_push", pr: ["7"] }, scenario.work),
		).rejects.toThrow(
			/array form of `pr` is valid for pr_checkout batching only/s,
		);
	});

	it("surfaces remote rejection without converting it to a force push", async () => {
		const scenario = seedPushScenario();
		// The remote moved ahead: the push is a non-fast-forward.
		const remoteClone = `${tempDir("pi-omp-git-remote-")}/rc`;
		execFileSync("git", ["clone", scenario.origin, remoteClone], {
			cwd: tempDir("p"),
		});
		execFileSync("git", ["-C", remoteClone, "config", "user.email", "a@e"]);
		execFileSync("git", ["-C", remoteClone, "config", "user.name", "a"]);
		execFileSync("git", ["-C", remoteClone, "checkout", "feature-7"]);
		const remoteAhead = commitFile(remoteClone, "remote.txt", "remote\n");
		execFileSync("git", [
			"-C",
			remoteClone,
			"push",
			"origin",
			"HEAD:refs/heads/feature-7",
		]);

		const { tool, gitCalls } = buildTool({ cwd: scenario.work });
		await expect(
			call(tool, { op: "pr_push", branch: "pr-7" }, scenario.work),
		).rejects.toThrow(/rejected by the remote[\s\S]*never[\s\S]*force push/s);

		// No force flag was ever attempted, and the remote ref stands.
		expect(gitCalls.some((args) => args.includes("--force"))).toBe(false);
		expect(git(["rev-parse", "refs/heads/feature-7"], scenario.origin)).toBe(
			remoteAhead,
		);
	});

	it("maps forceWithLease to --force-with-lease only", async () => {
		const scenario = seedPushScenario();
		// The remote-tracking ref matches the remote, so the lease holds.
		const { tool, gitCalls } = buildTool({ cwd: scenario.work });
		const result = await call(
			tool,
			{ op: "pr_push", branch: "pr-7", forceWithLease: true },
			scenario.work,
		);
		expect(resultText(result)).toContain("Force-with-lease: yes");
		const pushCall = gitCalls.find((args) => args[0] === "push");
		expect(pushCall).toContain("--force-with-lease");
		expect(pushCall).not.toContain("--force");
	});

	it("invalidates the PR's cached views and diffs after a successful push", async () => {
		const scenario = seedPushScenario();
		const { cache, invalidated } = fakeCache();
		const { tool } = buildTool({ cwd: scenario.work, cache });
		await call(tool, { op: "pr_push", branch: "pr-7" }, scenario.work);
		// pr and pr-diff rows, both comment modes, for this PR.
		const expected = [
			"pr:github.com/owner/repo#7:true",
			"pr:github.com/owner/repo#7:false",
			"pr-diff:github.com/owner/repo#7:true",
			"pr-diff:github.com/owner/repo#7:false",
		];
		for (const key of expected) {
			expect(invalidated).toContain(key);
		}
	});
});
