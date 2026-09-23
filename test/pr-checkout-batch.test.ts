/**
 * Ticket 12 acceptance tests: batch checkout with partial success,
 * fork-remote resolution, and identifier forms (docs/pi-omp-git-reference
 * .md §§24, 29, §95, divergences D4).
 *
 * External behavior only: `gh` flows through the scripted fixture seam;
 * `git` runs for real in temporary repositories. Fork URLs are made
 * fetchable locally with `url.<local>.insteadOf` rewrites, so no network
 * is ever touched.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../src/git/runner.ts";
import { createGitRunner } from "../src/git/runner.ts";
import { createGithubTool } from "../src/github/dispatcher.ts";
import { resolveForkRemote } from "../src/github/operations/pr-checkout.ts";
import { createGhRunner, type GhFixtureMap } from "../src/github/runner.ts";
import type { Exec } from "../src/shared/subprocess.ts";

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
		env: { ...process.env, LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null" },
	}).trim();
}

function makeBare(name: string): string {
	const path = join(tempDir(`pi-omp-git-${name}-`), `${name}.git`);
	execFileSync("git", ["init", "--bare", "-b", "main", path]);
	return path;
}

function makeClone(from: string, name: string): string {
	const dir = join(tempDir("pi-omp-git-clone-"), name);
	execFileSync("git", ["clone", from, dir], {
		cwd: tempDir("pi-omp-git-root-"),
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	git(["config", "user.email", "agent@example.com"], dir);
	git(["config", "user.name", "Agent"], dir);
	return dir;
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

const PR_VIEW_FIELDS =
	"number,url,title,state,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify";

function prPayload(options: {
	number: number;
	headRefName: string;
	headRefOid: string;
	crossRepository?: boolean;
	headOwner?: string;
	headRepo?: string;
	owner?: string;
	repo?: string;
}): string {
	const owner = options.owner ?? "owner";
	const repo = options.repo ?? "repo";
	return JSON.stringify({
		number: options.number,
		url: `https://github.com/${owner}/${repo}/pull/${options.number}`,
		title: `PR ${options.number}`,
		state: "OPEN",
		headRefName: options.headRefName,
		headRefOid: options.headRefOid,
		headRepository: { name: options.headRepo ?? repo },
		headRepositoryOwner: { login: options.headOwner ?? owner },
		isCrossRepository: options.crossRepository ?? false,
		maintainerCanModify: false,
	});
}

function buildTool(
	fixtures: GhFixtureMap,
	options: { cwd: string; worktreeRoot: string },
) {
	const merged: GhFixtureMap = {
		"gh --version": { stdout: "gh version 2.40.0\n", exitCode: 0 },
		"gh auth status": { exitCode: 0 },
		...fixtures,
	};
	const calls: CapturedCall[] = [];
	const exec: Exec = async (spec) => {
		calls.push({ command: spec.command, args: [...spec.args] });
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
		gh: createGhRunner({ exec }),
		git: gitProxy,
		availability: availabilityStub(),
		env: { GH_TOKEN: "test-token" },
		getWorktreeRoot: () => options.worktreeRoot,
	});
	return { tool, calls, gitCalls };
}

interface CapturedCall {
	command: string;
	args: string[];
}

function availabilityStub() {
	return {
		gh: async () => ({ ok: true as const }),
		git: async () => ({ ok: true as const }),
		reset: (): void => {},
		ensureGh: async (): Promise<void> => {},
		ensureGit: async (): Promise<void> => {},
	};
}

async function call(
	tool: ReturnType<typeof createGithubTool>,
	params: Record<string, unknown>,
	cwd: string,
): Promise<AgentToolResult<unknown>> {
	return tool.execute("tool-call-id", params as never, undefined, undefined, {
		cwd,
	} as never);
}

function gitRemoteNames(repo: string): string[] {
	return git(["remote"], repo)
		.split("\n")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

describe("pr_checkout: batch checkout", () => {
	it("checks every PR out; one failed PR never rolls back unrelated successes", async () => {
		const bare = makeBare("origin");
		const origin = makeClone(bare, "seed");
		execFileSync("git", ["-C", origin, "add", "."]);
		execFileSync("git", [
			"-C",
			origin,
			"commit",
			"--allow-empty",
			"-m",
			"base",
			"--no-gpg-sign",
		]);
		execFileSync("git", [
			"-C",
			origin,
			"push",
			"origin",
			"HEAD:refs/heads/main",
		]);
		const head40 = commitFile(origin, "pr-40.txt", "40\n");
		execFileSync("git", [
			"-C",
			origin,
			"push",
			bare,
			`${head40}:refs/pull/40/head`,
		]);
		const head41 = commitFile(origin, "pr-41.txt", "41\n");
		execFileSync("git", [
			"-C",
			origin,
			"push",
			"origin",
			"HEAD:refs/heads/main",
		]);
		execFileSync("git", [
			"-C",
			origin,
			"push",
			bare,
			`${head41}:refs/pull/41/head`,
		]);

		const work = makeClone(bare, "primary");
		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				[`gh pr view 40 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 40,
						headRefName: "feature-40",
						headRefOid: head40,
					}),
				},
				[`gh pr view 999 --json ${PR_VIEW_FIELDS}`]: {
					exitCode: 1,
					stderr: "could not resolve to a Pull Request\n",
				},
			},
			{ cwd: work, worktreeRoot },
		);

		const result = await call(
			tool,
			{ op: "pr_checkout", pr: ["40", "999"] },
			work,
		);

		// ≥1 success → a successful result with checkouts[] + failures[].
		const details = result.details as {
			checkouts?: unknown[];
			failures?: Array<{ pr: string; classification: string; error: string }>;
		};
		expect(details.checkouts).toHaveLength(1);
		expect(details.failures).toHaveLength(1);
		expect(details.failures?.[0]?.classification).toBe("not-found");
		expect(details.failures?.[0]?.pr).toBe("999");

		// The successful worktree was not rolled back.
		expect(git(["rev-parse", "refs/heads/pr-40"], work).trim()).toBe(head40);
		const text = String(
			result.content[0]?.type === "text" ? result.content[0].text : "",
		);
		expect(text).toContain("partial success");
		expect(text).toContain("[not-found]");
	});

	it("returns an error with the structured body when every checkout fails (D4)", async () => {
		const bare = makeBare("origin");
		const origin = makeClone(bare, "seed");
		execFileSync("git", ["-C", origin, "add", "."]);
		execFileSync("git", [
			"-C",
			origin,
			"commit",
			"--allow-empty",
			"-m",
			"base",
			"--no-gpg-sign",
		]);
		execFileSync("git", [
			"-C",
			origin,
			"push",
			"origin",
			"HEAD:refs/heads/main",
		]);
		const work = makeClone(bare, "primary");
		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				"gh pr view 998 --json number,url,title,state,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify":
					{
						exitCode: 1,
						stderr: "could not resolve to a Pull Request\n",
					},
				"gh pr view 999 --json number,url,title,state,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify":
					{
						exitCode: 1,
						stderr: "could not resolve to a Pull Request\n",
					},
			},
			{ cwd: work, worktreeRoot },
		);
		await expect(
			call(tool, { op: "pr_checkout", pr: ["998", "999"] }, work),
		).rejects.toThrow(
			/0 of 2 succeeded[\s\S]*PR 998 \[not-found\][\s\S]*PR 999 \[not-found\]/s,
		);
	});

	it("classifies conflicts and identifier errors per the §90 taxonomy", async () => {
		const bare = makeBare("origin");
		const origin = makeClone(bare, "seed");
		execFileSync("git", ["-C", origin, "add", "."]);
		execFileSync("git", [
			"-C",
			origin,
			"commit",
			"--allow-empty",
			"-m",
			"base",
			"--no-gpg-sign",
		]);
		execFileSync("git", [
			"-C",
			origin,
			"push",
			"origin",
			"HEAD:refs/heads/main",
		]);
		const head42 = commitFile(origin, "pr-42.txt", "42\n");
		execFileSync("git", [
			"-C",
			origin,
			"push",
			bare,
			`${head42}:refs/pull/42/head`,
		]);

		const work = makeClone(bare, "primary");
		const staleSha = commitFile(work, "stale.txt", "x\n");
		execFileSync("git", ["-C", work, "branch", "pr-42", staleSha]);

		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				[`gh pr view 42 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 42,
						headRefName: "feature-42",
						headRefOid: head42,
					}),
				},
				"gh pr view no-such-branch --json number,url,title,state,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify":
					{
						exitCode: 1,
						stderr: "no pull requests found for branch no-such-branch\n",
					},
			},
			{ cwd: work, worktreeRoot },
		);

		await expect(
			call(tool, { op: "pr_checkout", pr: ["42", "no-such-branch"] }, work),
		).rejects.toThrow(
			/0 of 2 succeeded[\s\S]*PR 42 \[checkout-conflict\][\s\S]*PR no-such-branch \[not-found\]/s,
		);
	});
});

describe("pr_checkout: fork PRs", () => {
	function seedForkScenario() {
		const bare = makeBare("origin");
		const fork = makeBare("fork");
		const origin = makeClone(bare, "seed");
		execFileSync("git", ["-C", origin, "add", "."]);
		execFileSync("git", [
			"-C",
			origin,
			"commit",
			"--allow-empty",
			"-m",
			"base",
			"--no-gpg-sign",
		]);
		execFileSync("git", [
			"-C",
			origin,
			"push",
			"origin",
			"HEAD:refs/heads/main",
		]);

		// The fork's branch: a clone of the fork bare with one commit.
		const forkClone = makeClone(fork, "fork-clone");
		const forkHead = commitFile(forkClone, "fork-change.txt", "fork\n");
		execFileSync("git", [
			"-C",
			forkClone,
			"push",
			"origin",
			`HEAD:refs/heads/feature-fork`,
		]);

		const work = makeClone(bare, "primary");
		return { bare, fork, forkHead, work };
	}

	it("adds a transport-matched push-capable fork remote for a fork PR", async () => {
		const { fork, forkHead, work } = seedForkScenario();
		// The https fork URL is fetchable locally via insteadOf — no network.
		execFileSync("git", [
			"-C",
			work,
			"config",
			`url.${fork}.insteadOf`,
			"https://github.com/alice/repo.git",
		]);
		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				[`gh pr view 45 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 45,
						headRefName: "feature-fork",
						headRefOid: forkHead,
						crossRepository: true,
						headOwner: "alice",
						headRepo: "repo",
					}),
				},
			},
			{ cwd: work, worktreeRoot },
		);

		const result = await call(tool, { op: "pr_checkout", pr: "45" }, work);

		// The fork remote was added with the origin transport (https default).
		expect(git(["config", "--get", "remote.fork-alice.url"], work)).toBe(
			"https://github.com/alice/repo.git",
		);
		// The head commit was fetched from the fork and checked out.
		const details = result.details as {
			worktreePath?: string;
			crossRepository?: boolean;
		};
		expect(git(["rev-parse", "HEAD"], details.worktreePath ?? "")).toBe(
			forkHead,
		);
		expect(git(["config", "--get", "branch.pr-45.pushRemote"], work)).toBe(
			"fork-alice",
		);
		expect(
			git(["config", "--get", "branch.pr-45.ompPrIsCrossRepository"], work),
		).toBe("true");
	});

	it("suffixes the fork remote name when the preferred name is taken", async () => {
		const { fork, forkHead, work } = seedForkScenario();
		// A pre-existing remote named fork-alice points somewhere else.
		execFileSync("git", [
			"-C",
			work,
			"remote",
			"add",
			"fork-alice",
			"/nonexistent/someone/else.git",
		]);
		// The https fork URL is fetchable locally via insteadOf — no network.
		execFileSync("git", [
			"-C",
			work,
			"config",
			`url.${fork}.insteadOf`,
			"https://github.com/alice/repo.git",
		]);
		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				[`gh pr view 46 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 46,
						headRefName: "feature-fork",
						headRefOid: forkHead,
						crossRepository: true,
						headOwner: "alice",
						headRepo: "repo",
					}),
				},
			},
			{ cwd: work, worktreeRoot },
		);
		const result = await call(tool, { op: "pr_checkout", pr: "46" }, work);
		const details = result.details as { worktreePath?: string };
		expect(details.worktreePath ?? "").not.toBe("");
		// The next fork-<owner> name was used and the fetch succeeded.
		expect(gitRemoteNames(work)).toEqual([
			"fork-alice",
			"fork-alice-2",
			"origin",
		]);
		expect(git(["config", "--get", "branch.pr-46.pushRemote"], work)).toBe(
			"fork-alice-2",
		);
		void fork;
	});
});

describe("resolveForkRemote: transport matching", () => {
	function scriptedGit(
		responses: Record<string, { stdout?: string; exitCode?: number }>,
	) {
		return {
			run(args: string[]) {
				const key = args.join(" ");
				const response = responses[key];
				if (!response) throw new Error(`unexpected git argv: ${key}`);
				return Promise.resolve({
					exitCode: response.exitCode ?? 0,
					stdout: response.stdout ?? "",
					stderr: "",
					truncated: false,
					timedOut: false,
					cancelled: false,
				});
			},
		} as unknown as GitRunner;
	}

	it("builds an ssh clone URL when origin is scp-like ssh", async () => {
		const scripted = scriptedGit({
			"remote -v": {
				stdout:
					"origin\tgit@github.com:owner/repo.git (fetch)\norigin\tgit@github.com:owner/repo.git (push)\n",
			},
			"remote get-url origin": { stdout: "git@github.com:owner/repo.git\n" },
			"remote add fork-alice git@github.com:alice/repo.git": { stdout: "" },
		});
		const remote = await resolveForkRemote(scripted, undefined, undefined, {
			host: "github.com",
			owner: "alice",
			name: "repo",
		});
		expect(remote).toBe("fork-alice");
	});

	it("builds an https clone URL when origin uses https", async () => {
		const scripted = scriptedGit({
			"remote -v": {
				stdout:
					"origin\thttps://github.com/owner/repo.git (fetch)\norigin\thttps://github.com:443/owner/repo.git (push)\n",
			},
			"remote get-url origin": {
				stdout: "https://github.com/owner/repo.git\n",
			},
			"remote add fork-alice https://github.com/alice/repo.git": { stdout: "" },
		});
		const remote = await resolveForkRemote(scripted, undefined, undefined, {
			host: "github.com",
			owner: "alice",
			name: "repo",
		});
		expect(remote).toBe("fork-alice");
	});

	it("reuses an existing remote whose push URL already points at the head repository", async () => {
		const scripted = scriptedGit({
			"remote -v": {
				stdout:
					"origin\thttps://github.com/owner/repo.git (fetch)\nupstream\thttps://github.com/alice/repo.git (fetch)\n",
			},
			"remote get-url origin": {
				stdout: "https://github.com/owner/repo.git\n",
			},
		});
		const remote = await resolveForkRemote(scripted, undefined, undefined, {
			host: "github.com",
			owner: "alice",
			name: "repo",
		});
		expect(remote).toBe("upstream");
	});

	it("suffixes fork remote names when the preferred name is taken", async () => {
		const scripted = scriptedGit({
			"remote -v": {
				stdout:
					"origin\thttps://github.com/owner/repo.git (fetch)\nfork-alice\thttps://github.com/someone/else.git (fetch)\n",
			},
			"remote get-url origin": {
				stdout: "https://github.com/owner/repo.git\n",
			},
			"remote add fork-alice-2 https://github.com/alice/repo.git": {
				stdout: "",
			},
		});
		const remote = await resolveForkRemote(scripted, undefined, undefined, {
			host: "github.com",
			owner: "alice",
			name: "repo",
		});
		expect(remote).toBe("fork-alice-2");
	});
});
