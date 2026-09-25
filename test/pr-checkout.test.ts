/**
 * Ticket 11 acceptance tests: `pr_checkout` single PR with managed
 * worktrees, branch metadata, conflicts, collisions, and the mutation
 * lock (docs/pi-omp-git-reference.md §§23–28, §31, §95).
 *
 * External behavior only: `gh` flows through the scripted fixture seam;
 * `git` runs for real in temporary repositories; repository state is
 * verified with git itself.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRunner } from "../src/git/runner.ts";
import { createGithubTool, type GithubTool } from "../src/github/dispatcher.ts";
import {
	repoRootHash,
	worktreeName,
} from "../src/github/operations/pr-checkout.ts";
import { createGhRunner, type GhFixtureMap } from "../src/github/runner.ts";
import { createRunner, type Exec } from "../src/shared/subprocess.ts";

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

/** Real git, parsed output, from one directory. */
function git(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
	}).trim();
}

interface BareRepo {
	path: string;
}

function makeBare(): BareRepo {
	const path = join(tempDir("pi-omp-git-origin-"), "origin.git");
	mkdirSync(path, { recursive: true });
	git(["init", "--bare", "-b", "main", path], tempDir("pi-omp-git-work-"));
	return { path };
}

function makeClone(from: string, name: string): string {
	const dir = join(tempDir("pi-omp-git-clone-"), name);
	git(["clone", from, dir], tempDir("pi-omp-git-clone-root-"));
	git(["config", "user.email", "agent@example.com"], dir);
	git(["config", "user.name", "Agent"], dir);
	return dir;
}

function commitFile(repo: string, file: string, content: string): string {
	writeFileSync(join(repo, file), content);
	git(["add", file], repo);
	git(["commit", "-m", `change ${file}`, "--no-gpg-sign"], repo);
	return git(["rev-parse", "HEAD"], repo).trim();
}

/** Publish one commit as the PR head `refs/pull/<n>/head` on the bare repo. */
function _publishPullRef(clone: string, _bare: string, number: number): string {
	return commitFile(clone, `pr-${number}.txt`, `content ${number}`);
}

function pushPullRef(
	clone: string,
	bare: string,
	number: number,
	sha: string,
): void {
	git(["push", bare, `${sha}:refs/pull/${number}/head`], clone);
}

const PR_VIEW_FIELDS =
	"number,url,title,state,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify";

function prPayload(options: {
	number: number;
	owner?: string;
	repo?: string;
	headRefName: string;
	headRefOid: string;
	crossRepository?: boolean;
	headOwner?: string;
	headRepo?: string;
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
		headRepositoryOwner: {
			login: options.headOwner ?? owner,
		},
		isCrossRepository: options.crossRepository ?? false,
		maintainerCanModify: false,
	});
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

function buildTool(
	fixtures: GhFixtureMap,
	options: {
		cwd: string;
		worktreeRoot: string;
	},
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
	const _runner = createRunner({ exec });
	const tool = createGithubTool({
		gh: createGhRunner({ exec }),
		// Real git in the temp checkout — never faked (testing seam 2).
		git: createGitRunner({}),
		availability: availabilityStub() as never,
		env: { GH_TOKEN: "test-token" },
		getWorktreeRoot: () => options.worktreeRoot,
	});
	return { tool, calls };
}

async function call(
	tool: GithubTool,
	params: Record<string, unknown>,
	cwd: string,
): Promise<AgentToolResult<unknown>> {
	return tool.execute("tool-call-id", params as never, undefined, undefined, {
		model: undefined,
		cwd,
	} as never);
}

function primaryHead(repo: string): { branch: string; sha: string } {
	return {
		branch: git(["rev-parse", "--abbrev-ref", "HEAD"], repo).trim(),
		sha: git(["rev-parse", "HEAD"], repo).trim(),
	};
}

describe("pr_checkout: single PR into a managed worktree", () => {
	it("checks a same-repo PR out into a dedicated worktree and leaves the primary checkout untouched", async () => {
		const bare = makeBare();
		const origin = makeClone(bare.path, "seed");
		const baseSha = commitFile(origin, "README.md", "# repo\n");
		git(["push", "origin", "HEAD:refs/heads/main"], origin);
		const prHead = commitFile(origin, "pr.txt", "418\n");
		pushPullRef(origin, bare.path, 418, prHead);

		const work = makeClone(bare.path, "primary");
		const before = primaryHead(work);

		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				[`gh pr view 418 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 418,
						headRefName: "feature-x",
						headRefOid: prHead,
					}),
				},
			},
			{ cwd: work, worktreeRoot },
		);
		const result = await call(tool, { op: "pr_checkout", pr: "418" }, work);

		// The user's original branch and commit are verifiably unchanged.
		expect(primaryHead(work)).toEqual(before);
		expect(primaryHead(work).sha).toBe(baseSha);

		// The worktree exists under the configured root with parity naming.
		const expectedName = worktreeName(418, realpathSync(work));
		const worktreePath = join(worktreeRoot, expectedName);
		expect(existsSync(worktreePath)).toBe(true);
		expect(git(["rev-parse", "HEAD"], worktreePath).trim()).toBe(prHead);

		// The local branch is pr-<number>.
		expect(
			git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath).trim(),
		).toBe("pr-418");

		// The result prominently carries the worktree path.
		const text = String(
			result.content[0]?.type === "text" ? result.content[0].text : "",
		);
		expect(text).toContain(worktreePath);
		expect(text).toContain("pr-418");

		void baseSha;
		void before;
	});

	it("persists the exact OMP-compatible branch metadata keys", async () => {
		const bare = makeBare();
		const origin = makeClone(bare.path, "seed");
		commitFile(origin, "README.md", "# repo\n");
		git(["push", "origin", "HEAD:refs/heads/main"], origin);
		const prHead = commitFile(origin, "pr.txt", "30\n");
		pushPullRef(origin, bare.path, 30, prHead);

		const work = makeClone(bare.path, "primary");
		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				[`gh pr view 30 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 30,
						headRefName: "feature-30",
						headRefOid: prHead,
					}),
				},
			},
			{ cwd: work, worktreeRoot },
		);
		const result = await call(tool, { op: "pr_checkout", pr: "30" }, work);
		const details = result.details as { worktreePath?: string };
		const _worktreePath = details.worktreePath ?? "";

		expect(git(["config", "--get", "branch.pr-30.remote"], work).trim()).toBe(
			"origin",
		);
		expect(git(["config", "--get", "branch.pr-30.merge"], work).trim()).toBe(
			"refs/heads/feature-30",
		);
		expect(
			git(["config", "--get", "branch.pr-30.pushRemote"], work).trim(),
		).toBe("origin");
		expect(
			git(["config", "--get", "branch.pr-30.ompPrHeadRef"], work).trim(),
		).toBe("feature-30");
		expect(git(["config", "--get", "branch.pr-30.ompPrUrl"], work).trim()).toBe(
			"https://github.com/owner/repo/pull/30",
		);
		expect(
			git(
				["config", "--get", "branch.pr-30.ompPrIsCrossRepository"],
				work,
			).trim(),
		).toBe("false");
		expect(
			git(
				["config", "--get", "branch.pr-30.ompPrMaintainerCanModify"],
				work,
			).trim(),
		).toBe("false");
	});

	it("reuses an existing pr-N branch at the PR head SHA", async () => {
		const bare = makeBare();
		const origin = makeClone(bare.path, "seed");
		commitFile(origin, "README.md", "# repo\n");
		git(["push", "origin", "HEAD:refs/heads/main"], origin);
		const prHead = commitFile(origin, "pr.txt", "7\n");
		pushPullRef(origin, bare.path, 7, prHead);

		const work = makeClone(bare.path, "primary");
		// The branch already exists at the correct SHA.
		git(["branch", "pr-7", prHead], work);
		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				[`gh pr view 7 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 7,
						headRefName: "feature-7",
						headRefOid: prHead,
					}),
				},
			},
			{ cwd: work, worktreeRoot },
		);
		const result = await call(tool, { op: "pr_checkout", pr: "7" }, work);
		const details = result.details as { reused?: boolean };
		expect(details.reused).toBe(true);
	});

	it("fails a wrong-SHA branch with a clear conflict and never resets silently", async () => {
		const bare = makeBare();
		const origin = makeClone(bare.path, "seed");
		commitFile(origin, "README.md", "# repo\n");
		git(["push", "origin", "HEAD:refs/heads/main"], origin);
		const prHead = commitFile(origin, "pr.txt", "12\n");
		pushPullRef(origin, bare.path, 12, prHead);

		const work = makeClone(bare.path, "primary");
		// A stale local branch at a different commit.
		const staleSha = commitFile(work, "stale.txt", "old work\n");
		git(["branch", "pr-12", staleSha], work);

		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				[`gh pr view 12 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 12,
						headRefName: "feature-12",
						headRefOid: prHead,
					}),
				},
			},
			{ cwd: work, worktreeRoot },
		);
		await expect(
			call(tool, { op: "pr_checkout", pr: "12" }, work),
		).rejects.toThrow(/exists at .*divergence D2.*force/s);

		// The branch was not silently reset.
		expect(git(["rev-parse", "refs/heads/pr-12"], work).trim()).toBe(staleSha);
	});

	it("force resets a wrong-SHA branch only when force is explicit", async () => {
		const bare = makeBare();
		const origin = makeClone(bare.path, "seed");
		commitFile(origin, "README.md", "# repo\n");
		git(["push", "origin", "HEAD:refs/heads/main"], origin);
		const prHead = commitFile(origin, "pr.txt", "14\n");
		pushPullRef(origin, bare.path, 14, prHead);

		const work = makeClone(bare.path, "primary");
		const staleSha = commitFile(work, "stale.txt", "old\n");
		git(["branch", "pr-14", staleSha], work);

		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				[`gh pr view 14 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 14,
						headRefName: "feature-14",
						headRefOid: prHead,
					}),
				},
			},
			{ cwd: work, worktreeRoot },
		);
		const result = await call(
			tool,
			{ op: "pr_checkout", pr: "14", force: true },
			work,
		);
		expect(git(["rev-parse", "refs/heads/pr-14"], work).trim()).toBe(prHead);
		const details = result.details as {
			worktreePath?: string;
			reused?: boolean;
		};
		expect(details.reused).toBe(false);
	});

	it("reuses an existing worktree detected by branch reference", async () => {
		const bare = makeBare();
		const origin = makeClone(bare.path, "seed");
		commitFile(origin, "README.md", "# repo\n");
		git(["push", "origin", "HEAD:refs/heads/main"], origin);
		const prHead = commitFile(origin, "pr.txt", "21\n");
		pushPullRef(origin, bare.path, 21, prHead);

		const work = makeClone(bare.path, "primary");
		const manualPath = join(tempDir("pi-omp-git-manual-"), "somewhere");
		mkdirSync(manualPath, { recursive: true });
		git(["worktree", "add", manualPath, "-b", "pr-21", prHead], work);

		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				[`gh pr view 21 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 21,
						headRefName: "feature-21",
						headRefOid: prHead,
					}),
				},
			},
			{ cwd: work, worktreeRoot },
		);
		const result = await call(tool, { op: "pr_checkout", pr: "21" }, work);
		const details = result.details as {
			worktreePath?: string;
			reused?: boolean;
		};
		// The existing worktree (at an unrelated path) is the one reused —
		// the branch already existed at the correct SHA.
		expect(details.worktreePath).toBe(realpathSync(manualPath));
		expect(details.reused).toBe(true);
	});

	it("suffixes path collisions with bounded numeric suffixes", async () => {
		const bare = makeBare();
		const origin = makeClone(bare.path, "seed");
		commitFile(origin, "README.md", "# repo\n");
		git(["push", "origin", "HEAD:refs/heads/main"], origin);
		const prHead = commitFile(origin, "pr.txt", "27\n");
		pushPullRef(origin, bare.path, 27, prHead);

		const work = makeClone(bare.path, "primary");
		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const preferred = join(worktreeRoot, worktreeName(27, realpathSync(work)));
		mkdirSync(preferred, { recursive: true });
		writeFileSync(join(preferred, "occupied"), "x");

		const { tool } = buildTool(
			{
				[`gh pr view 27 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 27,
						headRefName: "feature-27",
						headRefOid: prHead,
					}),
				},
			},
			{ cwd: work, worktreeRoot },
		);
		const result = await call(tool, { op: "pr_checkout", pr: "27" }, work);
		const details = result.details as { worktreePath?: string };
		expect(details.worktreePath).toBe(`${preferred}-2`);
	});

	it("accepts PR URL and branch-like identifiers; rejects JSON numbers", async () => {
		const bare = makeBare();
		const origin = makeClone(bare.path, "seed");
		commitFile(origin, "README.md", "# repo\n");
		git(["push", "origin", "HEAD:refs/heads/main"], origin);
		const prHead = commitFile(origin, "pr.txt", "33\n");
		pushPullRef(origin, bare.path, 33, prHead);

		const work = makeClone(bare.path, "primary");
		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				[`gh pr view https://github.com/owner/repo/pull/33 --json ${PR_VIEW_FIELDS}`]:
					{
						stdout: prPayload({
							number: 33,
							headRefName: "feature-33",
							headRefOid: prHead,
						}),
					},
			},
			{ cwd: work, worktreeRoot },
		);
		const result = await call(
			tool,
			{ op: "pr_checkout", pr: "https://github.com/owner/repo/pull/33" },
			work,
		);
		const details = result.details as { worktreePath?: string };
		expect(existsSync(details.worktreePath ?? "")).toBe(true);

		// JSON numbers are rejected at the dispatcher boundary.
		await expect(
			tool.execute(
				"id",
				{ op: "pr_checkout", pr: 33 } as never,
				undefined,
				undefined,
				{
					cwd: work,
				} as never,
			),
		).rejects.toThrow(/JSON numbers are rejected/s);
	});

	it("refuses a PR URL whose repository conflicts with the explicit repo (D3)", async () => {
		const bare = makeBare();
		const origin = makeClone(bare.path, "seed");
		commitFile(origin, "README.md", "# repo\n");
		git(["push", "origin", "HEAD:refs/heads/main"], origin);
		const prHead = commitFile(origin, "pr.txt", "35\n");
		pushPullRef(origin, bare.path, 35, prHead);

		const work = makeClone(bare.path, "primary");
		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				[`gh pr view 35 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 35,
						headRefName: "feature-35",
						headRefOid: prHead,
					}),
				},
			},
			{ cwd: work, worktreeRoot },
		);
		await expect(
			call(
				tool,
				{
					op: "pr_checkout",
					pr: "https://github.com/owner/repo/pull/35",
					repo: "other/repo",
				},
				work,
			),
		).rejects.toThrow(/Refusing the ambiguous target/s);
	});
});

describe("pr_checkout: serialization and details", () => {
	it("serializes simultaneous checkout calls so they do not race", async () => {
		const bare = makeBare();
		const origin = makeClone(bare.path, "seed");
		commitFile(origin, "README.md", "# repo\n");
		git(["push", "origin", "HEAD:refs/heads/main"], origin);
		const head40 = commitFile(origin, "pr-40.txt", "40\n");
		pushPullRef(origin, bare.path, 40, head40);
		const head41 = commitFile(origin, "pr-41.txt", "41\n");
		pushPullRef(origin, bare.path, 41, head41);

		const work = makeClone(bare.path, "primary");
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
				[`gh pr view 41 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 41,
						headRefName: "feature-41",
						headRefOid: head41,
					}),
				},
			},
			{ cwd: work, worktreeRoot },
		);
		// Two simultaneous single checkouts — the mutation lock orders them.
		await Promise.all([
			call(tool, { op: "pr_checkout", pr: "40" }, work),
			call(tool, { op: "pr_checkout", pr: "41" }, work),
		]);
		expect(git(["rev-parse", "refs/heads/pr-40"], work).trim()).toBe(head40);
		expect(git(["rev-parse", "refs/heads/pr-41"], work).trim()).toBe(head41);
	});

	it("reports the worktree path, branch, PR, and reused flag in details", async () => {
		const bare = makeBare();
		const origin = makeClone(bare.path, "seed");
		commitFile(origin, "README.md", "# repo\n");
		git(["push", "origin", "HEAD:refs/heads/main"], origin);
		const prHead = commitFile(origin, "pr.txt", "50\n");
		pushPullRef(origin, bare.path, 50, prHead);

		const work = makeClone(bare.path, "primary");
		const worktreeRoot = tempDir("pi-omp-git-wt-");
		const { tool } = buildTool(
			{
				[`gh pr view 50 --json ${PR_VIEW_FIELDS}`]: {
					stdout: prPayload({
						number: 50,
						headRefName: "feature-50",
						headRefOid: prHead,
					}),
				},
			},
			{ cwd: work, worktreeRoot },
		);
		const result = await call(tool, { op: "pr_checkout", pr: "50" }, work);
		const details = result.details as {
			op?: string;
			number?: number;
			url?: string;
			prBranch?: string;
			worktreePath?: string;
			reused?: boolean;
		};
		expect(details.op).toBe("pr_checkout");
		expect(details.number).toBe(50);
		expect(details.url).toBe("https://github.com/owner/repo/pull/50");
		expect(details.prBranch).toBe("pr-50");
		expect(details.worktreePath).toContain(worktreeRoot);
		expect(details.worktreePath).toContain(
			worktreeName(50, realpathSync(work)),
		);
		expect(details.reused).toBe(false);
	});
});

describe("pr_checkout helpers", () => {
	it("names worktrees <number>-<7-char repo root hash>", () => {
		const root = "/somewhere/repo";
		expect(worktreeName(914, root)).toBe(`914-${repoRootHash(root)}`);
		expect(repoRootHash(root)).toMatch(/^[0-9a-f]{7}$/);
	});

	it("parses porcelain worktree listings", async () => {
		const { parseWorktreeList } = await import(
			"../src/github/operations/pr-checkout.ts"
		);
		const entries = [
			"worktree /repo",
			"HEAD abc",
			"branch refs/heads/main",
			"",
			"worktree /repo/.worktrees/pr-5",
			"branch refs/heads/pr-5",
			"",
		].join("\n");
		const parsed = [
			{
				path: "/repo",
				branch: "refs/heads/main",
				head: "abc",
			},
			{
				path: "/repo/.worktrees/pr-5",
				branch: "refs/heads/pr-5",
				head: undefined,
			},
		];
		expect(parseWorktreeList(entries)).toEqual(parsed);
	});
});
