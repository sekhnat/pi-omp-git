/**
 * Ticket 14 acceptance tests: shell `gh` mutation invalidation
 * (docs/pi-omp-git-reference.md §57, §58) and the last-checkout record
 * (§110).
 *
 * The command string is parsed as a heuristic only; the fake cache
 * records every invalidation so narrow vs. whole-repository scope is
 * asserted at the tool boundary.
 */

import { describe, expect, it } from "vitest";
import type { GitRunner } from "../src/git/runner.ts";
import type { GithubCache } from "../src/github/cache/cache.ts";
import {
	createGhMutationInvalidator,
	detectGhMutations,
	ISSUE_MUTATION_VERBS,
	PR_MUTATION_VERBS,
} from "../src/github/invalidation.ts";
import {
	CHECKOUT_ENTRY_TYPE,
	findLastCheckout,
} from "../src/github/last-checkout.ts";

/** Recording fake cache: every invalidation lands in `calls`. */
function fakeCache(): { cache: GithubCache; calls: string[] } {
	const calls: string[] = [];
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
			calls.push(
				`row:${identity.kind}:${identity.host}/${identity.owner}/${identity.repo}#${identity.number}:${identity.includeComments}`,
			);
		},
		invalidatePrRows(target: {
			host: string;
			owner: string;
			repo: string;
			number: number;
		}) {
			calls.push(
				`pr-rows:${target.host}/${target.owner}/${target.repo}#${target.number}`,
			);
		},
		invalidateIssueRows(target: {
			host: string;
			owner: string;
			repo: string;
			number: number;
		}) {
			calls.push(
				`issue-rows:${target.host}/${target.owner}/${target.repo}#${target.number}`,
			);
		},
		invalidateRepo(target: { host: string; owner: string; repo: string }) {
			calls.push(`repo:${target.host}/${target.owner}/${target.repo}`);
		},
		flushBackground: async () => {},
	} as unknown as GithubCache;
	return { cache, calls };
}

function scriptedGit(output: string): GitRunner {
	return {
		run(_args: string[]) {
			return Promise.resolve({
				exitCode: 0,
				stdout: output,
				stderr: "",
				truncated: false,
				timedOut: false,
				cancelled: false,
			});
		},
	} as unknown as GitRunner;
}

function buildInvalidator(
	options: { remoteUrl?: string } = {},
	githubEnabled: () => boolean = () => true,
) {
	const { cache, calls } = fakeCache();
	const invalidator = createGhMutationInvalidator({
		cache,
		env: { GH_HOST: "github.com" },
		githubEnabled,
		git: scriptedGit(options.remoteUrl ?? "https://github.com/owner/repo"),
		resolveCurrentRepo: async () => ({
			host: "github.com",
			...(options.remoteUrl
				? { owner: "current", repo: "repo" }
				: { owner: "owner", repo: "repo" }),
		}),
	});
	return { invalidator, calls };
}

describe("detectGhMutations", () => {
	it("covers the full issue verb list", () => {
		for (const verb of ISSUE_MUTATION_VERBS) {
			const mutations = detectGhMutations(`gh issue ${verb} 12`);
			expect(mutations).toHaveLength(1);
			expect(mutations[0]).toMatchObject({ area: "issue", verb, number: 12 });
		}
	});

	it("covers the full PR verb list", () => {
		for (const verb of PR_MUTATION_VERBS) {
			const mutations = detectGhMutations(`gh pr ${verb} 33`);
			expect(mutations).toHaveLength(1);
			expect(mutations[0]).toMatchObject({ area: "pr", verb, number: 33 });
		}
	});

	it("ignores read verbs and non-gh commands", () => {
		expect(detectGhMutations("gh pr view 33")).toEqual([]);
		expect(detectGhMutations("gh issue list")).toEqual([]);
		expect(detectGhMutations("git push origin main")).toEqual([]);
		expect(detectGhMutations("echo gh pr close 3")).toEqual([]);
	});

	it("extracts number, repo flag, and URL targets", () => {
		expect(detectGhMutations("gh pr merge 12 --squash -R owner/repo")).toEqual([
			{ area: "pr", verb: "merge", owner: "owner", repo: "repo", number: 12 },
		]);
		expect(
			detectGhMutations(
				"gh issue close https://github.com/acme/widgets/issues/9",
			),
		).toEqual([
			{
				area: "issue",
				verb: "close",
				host: "github.com",
				owner: "acme",
				repo: "widgets",
				number: 9,
			},
		]);
	});

	it("detects mutations inside chained commands", () => {
		const mutations = detectGhMutations(
			"git add . && gh pr merge 21 --squash; echo done",
		);
		expect(mutations).toEqual([{ area: "pr", verb: "merge", number: 21 }]);
	});
});

describe("shell gh mutation invalidation", () => {
	it("skips cache invalidation while disabled and rechecks the live gate", async () => {
		let enabled = false;
		const { invalidator, calls } = buildInvalidator({}, () => enabled);
		expect(await invalidator.observe("gh issue close 12 -R owner/repo")).toBe(
			0,
		);
		expect(calls).toEqual([]);

		enabled = true;
		expect(await invalidator.observe("gh issue close 12 -R owner/repo")).toBe(
			1,
		);
		expect(calls).toEqual(["issue-rows:github.com/owner/repo#12"]);
	});

	it("invalidates issue rows narrowly before a mutating command runs", async () => {
		const { invalidator, calls } = buildInvalidator();
		const count = await invalidator.observe("gh issue close 12");
		expect(count).toBe(1);
		expect(calls).toEqual(["issue-rows:github.com/owner/repo#12"]);
	});

	it("invalidates pr and pr-diff rows for PR mutations with a number", async () => {
		const { invalidator, calls } = buildInvalidator();
		await invalidator.observe("gh pr merge 33 --squash");
		expect(calls).toEqual(["pr-rows:github.com/owner/repo#33"]);
	});

	it("invalidates the whole repository when the target is unidentifiable", async () => {
		const { invalidator, calls } = buildInvalidator();
		await invalidator.observe("gh pr merge --squash");
		expect(calls).toEqual(["repo:github.com/owner/repo"]);
	});

	it("uses the repository from the URL target when present", async () => {
		const { invalidator, calls } = buildInvalidator();
		await invalidator.observe(
			"gh pr close https://github.com/acme/widgets/pull/55",
		);
		expect(calls).toEqual(["pr-rows:github.com/acme/widgets#55"]);
	});

	it("resolves the current repository when the command names none", async () => {
		const { invalidator, calls } = buildInvalidator({
			remoteUrl: "https://github.com/current/repo",
		});
		await invalidator.observe("gh issue comment 4 --body hi");
		expect(calls).toEqual(["issue-rows:github.com/current/repo#4"]);
	});

	it("does nothing for read commands and non-matching text", async () => {
		const { invalidator, calls } = buildInvalidator();
		expect(await invalidator.observe("gh pr view 12")).toBe(0);
		expect(await invalidator.observe("ls -la")).toBe(0);
		expect(calls).toEqual([]);
	});

	it("invalidates for interactive ! commands through the same mechanism", async () => {
		const { invalidator, calls } = buildInvalidator();
		// The user_bash event delivers the command without the ! prefix;
		// the observer is identical to the bash-tool path.
		const count = await invalidator.observe("gh pr close 9");
		expect(count).toBe(1);
		expect(calls).toEqual(["pr-rows:github.com/owner/repo#9"]);
	});
});

describe("last-checkout records", () => {
	it("derives the last checkout from transcript entries", () => {
		const entries = [
			{
				type: "custom",
				customType: CHECKOUT_ENTRY_TYPE,
				data: {
					pr: "418",
					number: 418,
					branch: "pr-418",
					worktreePath: "/wt/418-abc",
					url: "https://github.com/owner/repo/pull/418",
				},
			},
			{ type: "message", role: "assistant" },
			{
				type: "custom",
				customType: CHECKOUT_ENTRY_TYPE,
				data: {
					pr: "500",
					number: 500,
					branch: "pr-500",
					worktreePath: "/wt/500-abc",
				},
			},
		];
		const last = findLastCheckout(entries);
		expect(last?.branch).toBe("pr-500");
		expect(last?.number).toBe(500);
		expect(last?.url).toBeUndefined();
	});

	it("ignores malformed entries and returns null without any", () => {
		expect(
			findLastCheckout([
				{
					type: "custom",
					customType: CHECKOUT_ENTRY_TYPE,
					data: { branch: "x" },
				},
				{ type: "custom", customType: "other" },
			]),
		).toBeNull();
		expect(findLastCheckout([])).toBeNull();
	});
});
