/**
 * Shell `gh` mutation invalidation — ticket 14
 * (docs/pi-omp-git-reference.md §57, §58).
 *
 * When the agent (or the user's interactive `!` command) runs a shell
 * command containing a recognizable `gh` mutation verb, the relevant
 * cached rows are invalidated **before** the command executes — whether
 * or not it ultimately succeeds (detection, not success; over-
 * invalidation beats staleness).
 *
 * Where host, repository, and number can be identified, invalidation is
 * narrow; when a mutation is detected but the exact target cannot be
 * established, all issue/PR rows for the repository are invalidated
 * (resolving the repository the way the current checkout does). The
 * command string is parsed as a heuristic only — it is never executed or
 * reinterpreted here.
 *
 * Observable scope: mutations from commands Pi never observes are
 * undetectable; the TTL is the backstop.
 */

import type { GitRunner } from "../git/runner.ts";
import type { GithubCache } from "./cache/cache.ts";
import { resolveCurrentGithubRepo } from "./repo.ts";

/**
 * The full verb list from the specification — issue
 * close/reopen/edit/comment/delete/lock/unlock/pin/unpin/transfer and PR
 * close/reopen/merge/ready/edit/comment/review/lock/unlock.
 */
export const ISSUE_MUTATION_VERBS = [
	"close",
	"reopen",
	"edit",
	"comment",
	"delete",
	"lock",
	"unlock",
	"pin",
	"unpin",
	"transfer",
] as const;

export const PR_MUTATION_VERBS = [
	"close",
	"reopen",
	"merge",
	"ready",
	"edit",
	"comment",
	"review",
	"lock",
	"unlock",
] as const;

export interface GhMutationTarget {
	area: "issue" | "pr";
	verb: string;
	host?: string;
	owner?: string;
	repo?: string;
	number?: number;
}

/** Split a command into pipeline/sequence segments without evaluating it. */
function segments(command: string): string[] {
	return command.split(/\n|&&|\|\||;|\|/);
}

/**
 * Heuristically detect `gh` mutation invocations in one shell command.
 * Recognition only — the string is never executed or reinterpreted.
 * Returns one target per mutating `gh` invocation found.
 */
export function detectGhMutations(command: string): GhMutationTarget[] {
	const targets: GhMutationTarget[] = [];
	for (const segment of segments(command)) {
		const target = detectOne(segment);
		if (target) targets.push(target);
	}
	return targets;
}

function detectOne(segment: string): GhMutationTarget | null {
	const tokens = segment
		.trim()
		.split(/\s+/)
		.filter((token) => token !== "");
	const ghIndex = tokens.findIndex(
		(token) => token === "gh" || token.endsWith("/gh"),
	);
	if (ghIndex < 0) return null;
	// Heuristic only: `echo gh ...` and friends are not invocations.
	const head = tokens.slice(0, ghIndex).map((token) => token.toLowerCase());
	if (head.some((token) => /^(echo|printf)$/.test(token))) return null;
	const subcommand = tokens[ghIndex + 1];
	if (subcommand !== "issue" && subcommand !== "pr") return null;

	const verbs: readonly string[] =
		subcommand === "issue" ? ISSUE_MUTATION_VERBS : PR_MUTATION_VERBS;

	// Heuristic recognition: the verb is the first token (after the
	// subcommand) that is one of the known mutation verbs — flags and
	// positional targets around it are scanned below, so both
	// `gh pr merge 12 --squash` and `gh issue edit -R o/r 12` are seen.
	const verbIndex = tokens.findIndex(
		(token, index) =>
			index > ghIndex + 1 && verbs.includes(token.toLowerCase()),
	);
	if (verbIndex < 0) return null;
	const verb = tokens[verbIndex]?.toLowerCase() ?? "";
	const afterVerb = tokens.slice(verbIndex + 1);

	// Scan the remainder for -R/--repo, a URL target, and a number.
	let repoScope: string | undefined;
	let urlTarget: string | undefined;
	let number: number | undefined;
	for (let index = 0; index < afterVerb.length; index += 1) {
		const token = afterVerb[index];
		if (!token) continue;
		if (token === "-R" || token === "--repo") {
			const value = afterVerb[index + 1];
			if (value && !value.startsWith("-")) repoScope = value;
			continue;
		}
		if (token.startsWith("-R=") || token.startsWith("--repo=")) {
			repoScope = token.slice(token.indexOf("=") + 1);
			continue;
		}
		if (
			/^https?:\/\//i.test(token) &&
			(token.includes("/issues/") || token.includes("/pull/"))
		) {
			urlTarget = token;
			continue;
		}
		if (number === undefined && /^\d+$/.test(token)) {
			number = Number(token);
		}
	}

	const target: GhMutationTarget = { area: subcommand, verb };
	if (number !== undefined) target.number = number;
	if (urlTarget) {
		const parsed =
			/^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/i.exec(
				urlTarget,
			);
		if (parsed) {
			target.host = parsed[1]?.toLowerCase();
			target.owner = parsed[2];
			target.repo = parsed[3];
			target.number = Number(parsed[4]);
		}
	}
	if (repoScope) {
		const parts = repoScope
			.replace(/\.git$/i, "")
			.split("/")
			.filter(Boolean);
		if (parts.length >= 2) {
			target.owner ??= parts[parts.length - 2];
			target.repo ??= parts[parts.length - 1];
			if (parts.length === 3) target.host ??= parts[0]?.toLowerCase();
		}
	}
	return target;
}


export interface GhMutationInvalidatorDeps {
	cache: GithubCache;
	env: NodeJS.ProcessEnv;
	git: GitRunner;
	/** Overridable current-repo resolution (tests). */
	resolveCurrentRepo?: typeof resolveCurrentGithubRepo;
}

export interface GhMutationInvalidator {
	/**
	 * Parse the command heuristically and invalidate matching cached rows
	 * before it runs. Returns the number of mutations acted on.
	 */
	observe(command: string): Promise<number>;
}

/**
 * The `bash`-tool / `!`-command observer: detects mutating `gh` commands
 * and invalidates cache rows before execution, whether or not the
 * command later succeeds.
 */
export function createGhMutationInvalidator(
	deps: GhMutationInvalidatorDeps,
): GhMutationInvalidator {
	const resolveCurrentRepo =
		deps.resolveCurrentRepo ?? resolveCurrentGithubRepo;

	return {
		async observe(command) {
			const mutations = detectGhMutations(command);
			if (mutations.length === 0) return 0;
			for (const mutation of mutations) {
				let host = mutation.host;
				let owner = mutation.owner;
				let repo = mutation.repo;
				if (!owner || !repo) {
					const current = await resolveCurrentRepo(
						{ git: deps.git, env: deps.env },
						undefined,
					).catch(() => null);
					if (!current) continue;
					host ??= current.host;
					owner ??= current.owner;
					repo ??= current.repo;
				}
				if (!owner || !repo) continue;
				const identity = {
					host: host ?? deps.env.GH_HOST ?? "github.com",
					owner,
					repo,
				};
				if (mutation.number !== undefined) {
					// Narrow invalidation: the exact resource is identifiable.
					if (mutation.area === "issue") {
						deps.cache.invalidateIssueRows({
							...identity,
							number: mutation.number,
						});
					} else {
						deps.cache.invalidatePrRows({
							...identity,
							number: mutation.number,
						});
					}
				} else {
					// The target number is not identifiable: over-invalidate the
					// whole repository's issue/PR rows (§58).
					deps.cache.invalidateRepo(identity);
				}
			}
			return mutations.length;
		},
	};
}
