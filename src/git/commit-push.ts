/**
 * `--push` routing (docs/pi-omp-git-reference.md §86).
 *
 * Push only after commit execution succeeded. PR branches created by
 * pr_checkout route through the PR push path (metadata, PR head ref,
 * force-with-lease semantics available); ordinary branches use the
 * configured upstream. Push rejections surface as errors and are never
 * converted to force pushes. A clean tree with an explicit `--push`
 * still pushes already-created local commits or clearly reports why no
 * push occurred.
 */

import { pushPullRequest } from "../github/operations/pr-push.ts";
import type { GhRunner } from "../github/runner.ts";
import { PiOmpGitError } from "../shared/errors.ts";
import type { GitRunner } from "./runner.ts";

export interface PushDeps {
	git: GitRunner;
	gh: GhRunner;
	cwd: string;
}

export interface PushOutcome {
	pushed: boolean;
	/** Human-readable report, including the reason nothing was pushed. */
	report: string;
}

/**
 * Push the branch's commits. `hasCommits` is true when the pipeline
 * created commits; with a clean tree the branch's unpushed commits are
 * pushed instead, or the reason is reported.
 */
export async function pushBranch(
	deps: PushDeps,
	options: { branch?: string; hasCommits: boolean },
	signal?: AbortSignal,
): Promise<PushOutcome> {
	const branch = options.branch ?? (await currentBranch(deps.git, deps.cwd));
	if (!branch) {
		return {
			pushed: false,
			report: "No push: HEAD is detached; check out a branch to push.",
		};
	}

	// PR branches created by pr_checkout carry OMP metadata (§86): route
	// through the PR push path (metadata, PR head ref, --force-with-lease).
	const metadata = await readPrMetadata(deps.git, deps.cwd, branch);
	if (metadata) {
		const outcome = await pushPullRequest(
			{ gh: deps.gh, git: deps.git, cwd: deps.cwd },
			{ branch },
			signal,
		);
		return { pushed: true, report: outcome.summary };
	}

	// Ordinary branches use the configured upstream.
	const upstream = await upstreamOf(deps.git, deps.cwd);
	if (!upstream) {
		return {
			pushed: false,
			report: `No push: branch ${branch} has no upstream configured — set one with 'git push -u' first.`,
		};
	}
	const unpushed = await countUnpushed(deps.git, deps.cwd);
	if (!options.hasCommits && unpushed === 0) {
		return {
			pushed: false,
			report: `No push: branch ${branch} has no unpushed commits relative to ${upstream}.`,
		};
	}
	const result = await deps.git.run(["push", upstream, branch], {
		cwd: deps.cwd,
		signal,
	});
	if ((result.exitCode ?? 99) !== 0) {
		// Rejection surfaces as an error — never converted to a force push.
		throw new PiOmpGitError(
			`Push of ${branch} to ${upstream} was rejected: ${(result.stderr || result.stdout || "git push failed").trim().slice(0, 500)}`,
		);
	}
	return {
		pushed: true,
		report: `Pushed ${branch} to ${upstream}${unpushed > 0 ? ` (${unpushed} commit(s))` : ""}.`,
	};
}

async function currentBranch(
	git: GitRunner,
	cwd: string,
): Promise<string | undefined> {
	const result = await git.run(["branch", "--show-current"], { cwd });
	if (result.exitCode !== 0) return undefined;
	const branch = result.stdout.trim();
	return branch || undefined;
}

async function readPrMetadata(
	git: GitRunner,
	cwd: string,
	branch: string,
): Promise<boolean> {
	const url = await git.run(["config", "--get", `branch.${branch}.ompPrUrl`], {
		cwd,
	});
	return url.exitCode === 0 && url.stdout.trim().length > 0;
}

async function upstreamOf(
	git: GitRunner,
	cwd: string,
): Promise<string | undefined> {
	const result = await git.run(
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
		{ cwd },
	);
	if (result.exitCode !== 0) return undefined;
	const full = result.stdout.trim();
	// "origin/main" style; a remote named with slashes is unusual enough
	// to trade for simplicity here.
	const slash = full.indexOf("/");
	return slash > 0 ? full.slice(0, slash) : full || undefined;
}

async function countUnpushed(git: GitRunner, cwd: string): Promise<number> {
	const check = await git.run(
		["rev-parse", "--verify", "--quiet", "@{upstream}"],
		{
			cwd,
		},
	);
	if (check.exitCode !== 0) return 0;
	const range = await git.run(["rev-list", "--count", "@{upstream}..HEAD"], {
		cwd,
	});
	if (range.exitCode !== 0) return 0;
	const count = Number(range.stdout.trim());
	return Number.isFinite(count) ? count : 0;
}
