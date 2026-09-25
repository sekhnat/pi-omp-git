/**
 * `github {op: "pr_push"}` — push a prepared PR branch back to its PR
 * (docs/pi-omp-git-reference.md §§32–33, §110; ticket 13).
 *
 * Target resolution: an explicit `pr` (text) or `branch` parameter first;
 * else the session's last checkout (transcript-derived, survives resume);
 * else the current branch's checkout metadata; else a clear error. A
 * branch without `branch.<name>.ompPrHeadRef` metadata yields the
 * deterministic metadata error — a contributor branch is never guessed.
 *
 * The push refspec is exactly `<source>:refs/heads/<ompPrHeadRef>` where
 * the source is HEAD when the branch is checked out in the primary
 * checkout, else `refs/heads/<branch>`. Only `--force-with-lease` exists
 * here (never plain `--force`); a remote rejection is surfaced as an
 * error, never converted into a force push. A successful push
 * invalidates that PR's cached views and diffs (§33).
 */

import { type Static, Type } from "typebox";
import type { GitRunner } from "../../git/runner.ts";
import {
	AuthenticationError,
	DependencyError,
	FRIENDLY_ERRORS,
	GitMutationError,
	PiOmpGitError,
	PrMetadataMissingError,
} from "../../shared/errors.ts";
import {
	CommandNotFoundError,
	type RunResult,
} from "../../shared/subprocess.ts";
import type { CacheIdentity, GithubCache } from "../cache/cache.ts";
import type { CheckoutRecord } from "../last-checkout.ts";
import { parsePrIdentifier } from "../pr-ref.ts";
import type { GhRunner } from "../runner.ts";
import { GithubParamsError, optionalNonEmptyString } from "./params.ts";

export interface PrPushDeps {
	gh: GhRunner;
	git: GitRunner;
	/** Primary checkout directory; the runner default when omitted. */
	cwd?: string;
	/** Cache rows invalidated after a confirmed successful push. */
	cache?: GithubCache;
	/** The session's most recent checkout (§110 resolution order). */
	getLastCheckout?: () => CheckoutRecord | null;
}

export interface PrPushTarget {
	pr?: string;
	branch?: string;
	forceWithLease?: boolean;
}

export const PR_PUSH_OPERATION_PARAMETERS = Type.Object({
	op: Type.Literal("pr_push"),
	pr: Type.Optional(Type.String()),
	branch: Type.Optional(Type.String()),
	forceWithLease: Type.Optional(Type.Boolean()),
});

export type PrPushOperationArguments = Static<
	typeof PR_PUSH_OPERATION_PARAMETERS
>;

export function validatePrPushOperationArguments(
	params: Record<string, unknown>,
): PrPushOperationArguments {
	if (Array.isArray(params.pr)) {
		throw new GithubParamsError(
			"pr_push accepts a single PR; the array form of `pr` is valid for pr_checkout batching only.",
		);
	}
	const pr = optionalNonEmptyString(params, "pr");
	const branch = optionalNonEmptyString(params, "branch");
	const forceWithLease = params.forceWithLease;
	if (
		forceWithLease !== undefined &&
		forceWithLease !== null &&
		typeof forceWithLease !== "boolean"
	) {
		throw new GithubParamsError(
			"The `forceWithLease` parameter must be a boolean.",
		);
	}
	return {
		op: "pr_push",
		...(pr !== undefined ? { pr } : {}),
		...(branch !== undefined ? { branch } : {}),
		...(typeof forceWithLease === "boolean" ? { forceWithLease } : {}),
	};
}

export type PrPushResolution =
	| "explicit-pr"
	| "explicit-branch"
	| "last-checkout"
	| "current-branch";

export interface PrPushOutcome {
	branch: string;
	pushRemote: string;
	headRef: string;
	source: string;
	forceWithLease: boolean;
	resolvedBy: PrPushResolution;
	url?: string;
	number?: number;
	summary: string;
}

/** The deterministic error a branch without checkout metadata yields. */
export function prMetadataMissingError(branch: string): PrMetadataMissingError {
	return new PrMetadataMissingError(
		`Branch "${branch}" has no PR checkout metadata.\nUse pr_checkout before pr_push.`,
	);
}

async function runGit(
	git: GitRunner,
	args: string[],
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<RunResult> {
	try {
		return await git.run(args, { signal, ...(cwd ? { cwd } : {}) });
	} catch (error) {
		if (error instanceof CommandNotFoundError) {
			throw new DependencyError(FRIENDLY_ERRORS.gitMissing, "git");
		}
		throw error;
	}
}

/** `git config --get` for one branch metadata key; null when unset. */
async function branchConfig(
	git: GitRunner,
	branch: string,
	key: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	const result = await runGit(
		git,
		["config", "--get", `branch.${branch}.${key}`],
		cwd,
		signal,
	);
	if (result.exitCode !== 0) return null;
	const value = result.stdout.trim();
	return value === "" ? null : value;
}

interface BranchMetadata {
	headRef: string | null;
	url: string | null;
	pushRemote: string | null;
	remote: string | null;
}

async function readBranchMetadata(
	git: GitRunner,
	branch: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<BranchMetadata> {
	const [headRef, url, pushRemote, remote] = await Promise.all([
		branchConfig(git, branch, "ompPrHeadRef", cwd, signal),
		branchConfig(git, branch, "ompPrUrl", cwd, signal),
		branchConfig(git, branch, "pushRemote", cwd, signal),
		branchConfig(git, branch, "remote", cwd, signal),
	]);
	return { headRef, url, pushRemote, remote };
}

/**
 * Find the local branch prepared for one PR by scanning
 * `branch.<name>.ompPrUrl` metadata; null when no branch matches.
 */
export async function findBranchForPullRequest(
	git: GitRunner,
	number: number,
	owner: string | undefined,
	repo: string | undefined,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const result = await runGit(
		git,
		["config", "--get-regexp", "^branch\\..*\\.ompPrUrl$"],
		cwd,
		signal,
	);
	if (result.exitCode !== 0) return undefined;
	for (const line of result.stdout.split("\n")) {
		const match = /^branch\.(\S+)\.ompPrUrl\s+(\S+)$/i.exec(line.trim());
		if (!match) continue;
		const branch = match[1];
		const url = match[2] ?? "";
		if (!branch) continue;
		const urlNumber = /\/pull\/(\d+)(?:[/?#].*)?$/.exec(url);
		if (!urlNumber || Number(urlNumber[1]) !== number) continue;
		if (owner && repo) {
			const urlOwnerRepo = /https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\//.exec(
				url,
			);
			if (urlOwnerRepo) {
				const same =
					urlOwnerRepo[1]?.toLowerCase() === owner.toLowerCase() &&
					urlOwnerRepo[2]?.toLowerCase() === repo.toLowerCase();
				if (!same) continue;
			}
		}
		return branch;
	}
	return undefined;
}

/** The current branch in the primary checkout; null when detached. */
async function currentBranch(
	git: GitRunner,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	const result = await runGit(git, ["branch", "--show-current"], cwd, signal);
	if (result.exitCode !== 0) return null;
	const branch = result.stdout.trim();
	return branch === "" ? null : branch;
}

/** Classify a failed `git push` (§33: never convert to a force push). */
export function classifyPushFailure(
	result: RunResult,
	pushRemote: string,
): PiOmpGitError {
	const stderr = result.stderr;
	if (stderr.includes("! [rejected]")) {
		return new GitMutationError(
			`The push to ${pushRemote} was rejected by the remote (non-fast-forward). ` +
				"Fetch and rebase the PR branch, then push again; `pr_push` never " +
				"converts a rejection into a force push. Use forceWithLease: true only " +
				"when you intend to overwrite the remote ref safely.",
		);
	}
	const lower = stderr.toLowerCase();
	if (
		/authentication failed|could not read username|could not read password|permission denied|terminal prompts disabled/.test(
			lower,
		)
	) {
		return new AuthenticationError(
			"The push could not authenticate with the remote.",
		);
	}
	const line = stderr
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0 && !entry.startsWith("Warning:"));
	const detail = line
		? line.length > 300
			? `${line.slice(0, 300)}…`
			: line
		: "";
	return new GitMutationError(
		detail
			? `The push to ${pushRemote} failed: ${detail}`
			: `The push to ${pushRemote} failed with exit code ${result.exitCode ?? "signal"}.`,
	);
}

/** Parse a PR URL into the cache identity parts; null when unparseable. */
function parsePrUrlIdentity(
	url: string,
): { host: string; owner: string; repo: string; number: number } | null {
	const match =
		/^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
			url.trim(),
		);
	if (!match) return null;
	return {
		host: match[1]?.toLowerCase() ?? "",
		owner: match[2] ?? "",
		repo: match[3] ?? "",
		number: Number(match[4]),
	};
}

/**
 * Push one PR branch back to its PR (§32–33). Resolution: explicit
 * `pr`/`branch` → session last checkout → current-branch metadata.
 */
export async function pushPullRequest(
	deps: PrPushDeps,
	target: PrPushTarget,
	signal?: AbortSignal,
): Promise<PrPushOutcome> {
	const explicitPr =
		typeof target.pr === "string" ? target.pr.trim() : undefined;
	if (explicitPr !== undefined && explicitPr !== "" && target.branch) {
		throw new PiOmpGitError(
			"pr_push accepts an explicit `pr` or `branch`, not both.",
		);
	}

	let branch: string | undefined;
	let resolvedBy: PrPushResolution = "current-branch";
	if (explicitPr) {
		resolvedBy = "explicit-pr";
		const parsed = parsePrIdentifier(explicitPr);
		if (!parsed) {
			throw new PiOmpGitError(
				`Invalid PR identifier: ${explicitPr}. Use a PR number as text, a PR URL, or a branch-like identifier.`,
			);
		}
		if (parsed.kind === "branch") {
			// Branch-like PR identifiers must resolve through gh to a PR,
			// then to the local branch prepared by pr_checkout.
			const pull = await resolvePrThroughGh(deps, explicitPr, signal);
			branch = await findBranchForPullRequest(
				deps.git,
				pull.number,
				pull.owner,
				pull.repo,
				deps.cwd,
				signal,
			);
		} else {
			const number = parsed.kind === "number" ? parsed.number : parsed.number;
			const owner = parsed.kind === "url" ? parsed.owner : undefined;
			const repo = parsed.kind === "url" ? parsed.repo : undefined;
			branch = await findBranchForPullRequest(
				deps.git,
				number,
				owner,
				repo,
				deps.cwd,
				signal,
			);
		}
		if (!branch) {
			throw new PiOmpGitError(
				`No local branch has PR checkout metadata for ${explicitPr}.\nUse pr_checkout before pr_push.`,
			);
		}
	} else if (target.branch) {
		resolvedBy = "explicit-branch";
		branch = target.branch;
	} else if (deps.getLastCheckout) {
		const last = deps.getLastCheckout();
		if (last) {
			resolvedBy = "last-checkout";
			branch = last.branch;
		}
	}
	if (!branch) {
		resolvedBy = "current-branch";
		const current = await currentBranch(deps.git, deps.cwd, signal);
		if (current) branch = current;
	}
	if (!branch) {
		throw new PiOmpGitError(
			"pr_push could not resolve a target: pass an explicit `pr` or `branch`, check out a PR first, or run on a branch with PR checkout metadata.",
		);
	}

	const metadata = await readBranchMetadata(deps.git, branch, deps.cwd, signal);
	if (!metadata.headRef) {
		throw prMetadataMissingError(branch);
	}
	const pushRemote = metadata.pushRemote ?? metadata.remote ?? "origin";

	// §33 refspec: HEAD when the branch is checked out here, else its ref.
	const current = await currentBranch(deps.git, deps.cwd, signal);
	const source = current === branch ? "HEAD" : `refs/heads/${branch}`;
	const refspec = `${source}:refs/heads/${metadata.headRef}`;

	const argv = ["push", pushRemote, refspec];
	if (target.forceWithLease) argv.push("--force-with-lease");

	let result: RunResult;
	try {
		result = await deps.git.run(argv, { signal, cwd: deps.cwd });
	} catch (error) {
		if (error instanceof CommandNotFoundError) {
			throw new DependencyError(FRIENDLY_ERRORS.gitMissing, "git");
		}
		throw error;
	}
	if (result.exitCode !== 0) {
		throw classifyPushFailure(result, pushRemote);
	}

	// A successful push invalidates the PR's cached views and diffs (§33).
	const url = metadata.url ?? undefined;
	const identity = url ? parsePrUrlIdentity(url) : null;
	if (identity && deps.cache) {
		const base = {
			host: identity.host,
			owner: identity.owner,
			repo: identity.repo,
		};
		const modes: CacheIdentity["includeComments"][] = [true, false];
		for (const includeComments of modes) {
			deps.cache.invalidate({
				...base,
				kind: "pr",
				number: identity.number,
				includeComments,
			});
			deps.cache.invalidate({
				...base,
				kind: "pr-diff",
				number: identity.number,
				includeComments,
			});
		}
	}

	const summary = [
		`Pushed ${branch} → ${pushRemote} ${refspec}`,
		url ? `PR: ${url}` : undefined,
		`Resolution: ${resolvedBy}`,
		`Force-with-lease: ${target.forceWithLease ? "yes" : "no"}`,
		identity
			? "The PR's cached views and diffs were invalidated; the next read re-fetches."
			: undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");

	return {
		branch,
		pushRemote,
		headRef: metadata.headRef,
		source,
		forceWithLease: Boolean(target.forceWithLease),
		resolvedBy,
		...(url ? { url } : {}),
		...(identity ? { number: identity.number } : {}),
		summary,
	};
}

/** Resolve a branch-like PR identifier to its PR through gh. */
async function resolvePrThroughGh(
	deps: PrPushDeps,
	identifier: string,
	signal: AbortSignal | undefined,
): Promise<{ number: number; owner?: string; repo?: string }> {
	let result: RunResult;
	try {
		result = await deps.gh.run(
			["pr", "view", identifier, "--json", "number,url"],
			{ signal, cwd: deps.cwd },
		);
	} catch (error) {
		if (error instanceof CommandNotFoundError) {
			throw new DependencyError(FRIENDLY_ERRORS.ghMissing, "gh");
		}
		throw error;
	}
	if (result.exitCode !== 0) {
		const detail = result.stderr
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		throw new PiOmpGitError(
			detail
				? `Resolving the pull request for "${identifier}" failed: ${detail.slice(0, 300)}`
				: `Resolving the pull request for "${identifier}" failed.`,
		);
	}
	try {
		const payload = JSON.parse(result.stdout) as Record<string, unknown>;
		const number = payload.number;
		if (typeof number !== "number") {
			throw new PiOmpGitError(
				`gh returned no pull request number for "${identifier}".`,
			);
		}
		const url = typeof payload.url === "string" ? payload.url : "";
		const identity = parsePrUrlIdentity(url);
		return {
			number,
			...(identity ? { owner: identity.owner, repo: identity.repo } : {}),
		};
	} catch (error) {
		if (error instanceof PiOmpGitError) throw error;
		throw new PiOmpGitError(
			`gh returned an unexpected payload for "${identifier}".`,
		);
	}
}
