/**
 * Unit tests for the pure input/ref/target planners extracted from PR
 * checkout (`pr-checkout.ts`) and Actions watching (`run-watch.ts`) into
 * `src/github/operations/planning.ts` (task 4.6 side-effect separation).
 *
 * These planners are deterministic and I/O-free: every case here runs
 * without a gh/git seam, a filesystem, or a clock. The scripted-operation
 * behavior itself stays covered by `test/pr-checkout.test.ts` (real temp
 * repositories) and `test/run-watch.test.ts` (scripted gh + virtual clock).
 */

import { describe, expect, it } from "vitest";
import {
	checkRunUrlRepoConflict,
	parseRunIdentifier,
	planBaseIdentity,
	planCheckoutTarget,
	planCommitShaSource,
	planPrCheckoutBatch,
	planPrCheckoutRef,
	planWatchTarget,
} from "../src/github/operations/planning.ts";
import { PiOmpGitError } from "../src/shared/errors.ts";

describe("pr_checkout batch planning", () => {
	it("normalizes a single identifier and an array with trimming", () => {
		expect(planPrCheckoutBatch(" 418 ")).toEqual(["418"]);
		expect(planPrCheckoutBatch(["a", " b ", "c"])).toEqual(["a", "b", "c"]);
	});

	it("drops empty entries but rejects an all-empty batch", () => {
		expect(planPrCheckoutBatch(["", "  ", "418"])).toEqual(["418"]);
		expect(() => planPrCheckoutBatch("   ")).toThrow(PiOmpGitError);
		expect(() => planPrCheckoutBatch(["", " "])).toThrow(
			/The `pr` parameter is required for pr_checkout/,
		);
	});
});

describe("pr_checkout ref planning", () => {
	it("parses numbers, PR URLs, and branch-like identifiers", () => {
		expect(planPrCheckoutRef("418", undefined)).toEqual({
			kind: "number",
			number: 418,
			text: "418",
		});
		expect(
			planPrCheckoutRef("https://github.com/o/r/pull/7", undefined),
		).toEqual({
			kind: "url",
			url: "https://github.com/o/r/pull/7",
			host: "github.com",
			owner: "o",
			repo: "r",
			number: 7,
		});
		expect(planPrCheckoutRef("feature/x", undefined)).toEqual({
			kind: "branch",
			ref: "feature/x",
		});
	});

	it("rejects invalid identifiers and URL/repo conflicts (D3)", () => {
		expect(() => planPrCheckoutRef("", undefined)).toThrow(
			/Invalid PR identifier/,
		);
		expect(() =>
			planPrCheckoutRef("https://github.com/o/r/pull/7", "other/other"),
		).toThrow(PiOmpGitError);
	});
});

describe("pr_checkout base identity planning", () => {
	it("a PR URL names its own repository", () => {
		const parsed = planPrCheckoutRef(
			"https://github.com/o/r/pull/7",
			undefined,
		);
		expect(planBaseIdentity(parsed, undefined, "example.com")).toEqual({
			host: "github.com",
			owner: "o",
			repo: "r",
		});
	});

	it("an explicit repo parses as host/owner/repo or owner/repo", () => {
		const parsed = planPrCheckoutRef("418", undefined);
		expect(planBaseIdentity(parsed, "host.com/o/r", undefined)).toEqual({
			host: "host.com",
			owner: "o",
			repo: "r",
		});
		expect(planBaseIdentity(parsed, "o/r", "gh.example.com")).toEqual({
			host: "gh.example.com",
			owner: "o",
			repo: "r",
		});
		expect(planBaseIdentity(parsed, "o/r", undefined)).toEqual({
			host: "github.com",
			owner: "o",
			repo: "r",
		});
	});

	it("returns null when the caller must resolve the current repo", () => {
		const parsed = planPrCheckoutRef("418", undefined);
		expect(planBaseIdentity(parsed, undefined, "gh.example.com")).toBeNull();
		expect(planBaseIdentity(parsed, "a/b/c/d", undefined)).toBeNull();
	});
});

describe("pr_checkout target planning", () => {
	const base = { host: "github.com", owner: "o", repo: "r" };

	it("derives branch, fallbacks, and an origin fetch for a same-repo PR", () => {
		const plan = planCheckoutTarget(
			{
				number: 7,
				url: "https://github.com/o/r/pull/7",
				headRefName: "feature",
				isCrossRepository: false,
				maintainerCanModify: true,
			},
			base,
		);
		expect(plan).toMatchObject({
			branch: "pr-7",
			headRefName: "feature",
			pullUrl: "https://github.com/o/r/pull/7",
			crossRepository: false,
			maintainerCanModify: true,
			fetch: { kind: "origin", ref: "pull/7/head" },
		});
	});

	it("falls back for missing headRefName/url and maintainerCanModify", () => {
		const plan = planCheckoutTarget({ number: 9 }, base);
		expect(plan.headRefName).toBe("pull/9/head");
		expect(plan.pullUrl).toBe("https://github.com/o/r/pull/9");
		expect(plan.maintainerCanModify).toBe(false);
		expect(plan.crossRepository).toBe(false);
	});

	it("plans a fork fetch for a cross-repository PR", () => {
		const plan = planCheckoutTarget(
			{
				number: 11,
				headRefName: "fork-branch",
				isCrossRepository: true,
				headRepositoryOwner: { login: "contributor" },
				headRepository: { name: "forked" },
			},
			base,
		);
		expect(plan.crossRepository).toBe(true);
		expect(plan.fetch).toEqual({
			kind: "fork",
			head: { host: "github.com", owner: "contributor", name: "forked" },
			ref: "fork-branch",
		});
	});

	it("infers cross-repository from owner/repo mismatch when absent", () => {
		const inferred = planCheckoutTarget(
			{
				number: 13,
				headRepositoryOwner: { login: "other" },
				headRepository: { name: "r" },
			},
			base,
		);
		expect(inferred.crossRepository).toBe(true);
		expect(inferred.fetch.kind).toBe("fork");
		expect(
			planCheckoutTarget(
				{
					number: 14,
					headRepositoryOwner: { login: "o" },
					headRepository: { name: "r" },
				},
				base,
			).crossRepository,
		).toBe(false);
		// Inference needs both head fields; owner alone stays same-repo.
		expect(
			planCheckoutTarget(
				{ number: 15, headRepositoryOwner: { login: "other" } },
				base,
			).crossRepository,
		).toBe(false);
	});
});

describe("run_watch target planning", () => {
	it("plans run mode from a bare ID with repo identity", () => {
		const plan = planWatchTarget({ run: " 123 ", repo: "o/r" });
		expect(plan).toEqual({
			mode: "run",
			runNumber: 123,
			repoIdentity: { host: "github.com", owner: "o", repo: "r" },
			needsCurrentRepo: false,
		});
	});

	it("a run URL supplies the identity and must agree with repo", () => {
		const plan = planWatchTarget({
			run: "https://github.com/o/r/actions/runs/77",
		});
		expect(plan).toEqual({
			mode: "run",
			runNumber: 77,
			urlIdentity: { host: "github.com", owner: "o", repo: "r" },
			needsCurrentRepo: false,
		});
		expect(() =>
			planWatchTarget({
				run: "https://github.com/o/r/actions/runs/77",
				repo: "other/other",
			}),
		).toThrow(PiOmpGitError);
		expect(() =>
			planWatchTarget({
				run: "https://github.com/o/r/actions/runs/77",
				repo: "github.com/o/r",
			}),
		).not.toThrow();
	});

	it("plans commit mode and flags current-repo resolution", () => {
		expect(planWatchTarget({})).toEqual({
			mode: "commit",
			needsCurrentRepo: true,
		});
		expect(planWatchTarget({ repo: "host.com/o/r" })).toEqual({
			mode: "commit",
			repoIdentity: { host: "host.com", owner: "o", repo: "r" },
			needsCurrentRepo: false,
		});
	});

	it("rejects invalid run and repo identifiers", () => {
		expect(() => planWatchTarget({ run: "main" })).toThrow(
			/`run` must be a run ID or a GitHub Actions run URL/,
		);
		expect(() => planWatchTarget({ repo: "not-a-repo" })).toThrow(
			/`repo` must be owner\/repo or host\/owner\/repo/,
		);
	});
});

describe("run_watch commit-SHA source planning", () => {
	it("validates and prefers an explicit commit", () => {
		expect(planCommitShaSource({ commit: " abc123 " })).toEqual({
			kind: "commit",
			sha: "abc123",
		});
		expect(() => planCommitShaSource({ commit: "main" })).toThrow(
			/`commit` must be a commit SHA/,
		);
	});

	it("orders pr, last-checkout branch, and HEAD fallback", () => {
		expect(planCommitShaSource({ pr: " 418 " })).toEqual({
			kind: "pr",
			pr: "418",
		});
		expect(planCommitShaSource({ lastBranch: "pr-7" })).toEqual({
			kind: "last-checkout",
			branch: "pr-7",
		});
		expect(planCommitShaSource({})).toEqual({ kind: "head" });
		expect(planCommitShaSource({ lastBranch: null })).toEqual({
			kind: "head",
		});
		// A pr beats the last-checkout branch.
		expect(planCommitShaSource({ pr: "418", lastBranch: "pr-7" })).toEqual({
			kind: "pr",
			pr: "418",
		});
	});
});

describe("run identifier parsing (moved planner)", () => {
	it("accepts run IDs and Actions URLs (with attempts suffix)", () => {
		expect(parseRunIdentifier(" 1234567 ")).toEqual({
			kind: "number",
			number: 1234567,
		});
		expect(
			parseRunIdentifier("https://github.com/o/r/actions/runs/77"),
		).toMatchObject({ kind: "url", number: 77 });
		expect(
			parseRunIdentifier("https://github.com/o/r/actions/runs/77/attempts/2")
				?.kind,
		).toBe("url");
		expect(parseRunIdentifier("main")).toBeNull();
		expect(parseRunIdentifier("https://github.com/o/r/pull/7")).toBeNull();
	});

	it("rejects a run URL conflicting with an explicit repo (D3 pattern)", () => {
		const parsed = parseRunIdentifier(
			"https://github.com/owner/repo/actions/runs/77",
		);
		expect(parsed?.kind).toBe("url");
		if (parsed?.kind !== "url") return;
		expect(() => checkRunUrlRepoConflict(parsed, "other/other")).toThrow(
			PiOmpGitError,
		);
		expect(() =>
			checkRunUrlRepoConflict(parsed, "github.com/other/other"),
		).toThrow(PiOmpGitError);
		expect(() => checkRunUrlRepoConflict(parsed, "owner/repo")).not.toThrow();
	});
});
