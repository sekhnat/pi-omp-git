/**
 * Current-repository resolution — used by cache identity (ticket 03) and
 * any bare-form operation that must know which GitHub repository the
 * current checkout maps to (docs/pi-omp-git-reference.md §50, §88).
 *
 * `gh` performs its own repository resolution from git remotes when an
 * operation carries no explicit repository. To scope cache keys (and to
 * fail fast with the friendly repository-context error), the resolution
 * here mirrors gh's origin-first rule through a cheap local git call —
 * never through a network operation.
 */

import type { GitRunner } from "../git/runner.ts";
import { NoRepositoryContextError } from "../shared/errors.ts";

export interface GithubRepoIdentity {
	host: string;
	owner: string;
	repo: string;
}

export interface ResolveRepoDeps {
	git: GitRunner;
	env: NodeJS.ProcessEnv;
}

/**
 * Resolve `{ host, owner, repo }` from the checkout's `origin` remote.
 * Host falls back to `GH_HOST`, then github.com. Throws the friendly
 * `NoRepositoryContextError` when the checkout yields no GitHub remote.
 */
export async function resolveCurrentGithubRepo(
	deps: ResolveRepoDeps,
	signal?: AbortSignal,
): Promise<GithubRepoIdentity> {
	const result = await deps.git.run(["remote", "get-url", "origin"], {
		signal,
	});
	if (result.exitCode !== 0) {
		throw new NoRepositoryContextError();
	}
	const parsed = parseGitRemoteUrl(result.stdout.trim());
	if (!parsed) {
		throw new NoRepositoryContextError();
	}
	return {
		host: parsed.host ?? deps.env.GH_HOST ?? "github.com",
		owner: parsed.owner,
		repo: parsed.repo,
	};
}

export interface ParsedRemote {
	host?: string;
	owner: string;
	repo: string;
}

/**
 * Parse the supported remote URL spellings:
 *
 *   git@host:owner/repo(.git)
 *   ssh://git@host/owner/repo(.git)
 *   https://host/owner/repo(.git)
 *   owner/repo
 *
 * Returns null when no owner/repo pair can be recovered.
 */
export function parseGitRemoteUrl(url: string): ParsedRemote | null {
	const trimmed = url.trim().replace(/\.git$/i, "");
	if (!trimmed) return null;

	// scp-like: git@host:owner/repo
	const scpLike = /^git@([^:/]+):([^/]+)\/(.+)$/.exec(trimmed);
	if (scpLike) {
		return {
			host: scpLike[1] ?? undefined,
			owner: scpLike[2] ?? "",
			repo: scpLike[3] ?? "",
		};
	}

	// ssh://git@host[:port]/owner/repo — strip an optional port.
	const sshUrl = /^ssh:\/\/(?:[^@/]+@)?([^/:?#]+)(?::\d+)?\/(.+)$/.exec(
		trimmed,
	);
	if (sshUrl) {
		const pair = splitOwnerRepo(sshUrl[2] ?? "");
		if (pair) return { host: sshUrl[1], owner: pair.owner, repo: pair.repo };
		return null;
	}

	// https://host/owner/repo — with optional credentials in the URL.
	const httpUrl = /^https?:\/\/(?:[^@/]+@)?([^/:?#]+)(?::\d+)?\/(.+)$/.exec(
		trimmed,
	);
	if (httpUrl) {
		const pair = splitOwnerRepo(httpUrl[2] ?? "");
		if (pair) return { host: httpUrl[1], owner: pair.owner, repo: pair.repo };
		return null;
	}

	// Bare `owner/repo` shorthand.
	const bare = /^([^/]+)\/(.+)$/.exec(trimmed);
	if (bare) {
		return { owner: bare[1] ?? "", repo: bare[2] ?? "" };
	}
	return null;
}

export interface ParsedRepoIdentifier {
	host?: string;
	owner: string;
	repo: string;
}

/**
 * Parse the §19 repository identifier forms:
 *
 *   owner/repo
 *   host/owner/repo
 *
 * Returns null for anything else (empty segments, URLs, single words).
 * Use this for explicit `repo` tool parameters — distinct from
 * `parseGitRemoteUrl`, which covers git remote URL spellings.
 */
export function parseGithubRepoIdentifier(
	identifier: string,
): ParsedRepoIdentifier | null {
	const trimmed = identifier.trim();
	if (!trimmed) return null;
	const segments = trimmed.split("/");
	if (segments.length === 2) {
		const [owner, repo] = segments as [string, string];
		return owner && repo ? { owner, repo } : null;
	}
	if (segments.length === 3) {
		const [host, owner, repo] = segments as [string, string, string];
		return host && owner && repo ? { host, owner, repo } : null;
	}
	return null;
}
function splitOwnerRepo(rest: string): { owner: string; repo: string } | null {
	const segments = rest.split("/").filter((segment) => segment !== "");
	if (segments.length < 2) return null;
	const owner = segments[0] ?? "";
	const repo = segments[1] ?? "";
	if (!owner || !repo) return null;
	return { owner, repo };
}
