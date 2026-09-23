/**
 * `github {op: "pr_checkout"}` — managed-worktree PR checkout
 * (docs/pi-omp-git-reference.md §§23–31, tickets 11 and 12).
 *
 * Invariants:
 * - the user's current checkout is never mutated; every PR lives in a
 *   dedicated worktree under the configured root (§23);
 * - the local branch is `pr-<number>` with OMP-compatible branch metadata
 *   (§25, §30), so `pr_push` is deterministic;
 * - an existing correct-SHA branch is reused; a wrong-SHA branch fails
 *   with a clear conflict unless `force` resets it — never a silent reset
 *   (§28, divergence D2);
 * - worktree detection keys on the branch reference; path collisions take
 *   bounded numeric suffixes (§27);
 * - shared-repository mutations serialize by primary repository root
 *   through the mutation lock (§31);
 * - batch checkout permits partial success: ≥1 success → successful
 *   result with `checkouts[]` and structured `failures[]`; 0 successes →
 *   error with the same structured body (§24, divergence D4);
 * - fork PRs resolve a push-capable head-repository remote, reusing an
 *   existing correct remote and otherwise adding a transport-matched
 *   `fork-<owner>` remote (§29).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RepositoryMutationLock } from "../../git/mutation-lock.ts";
import type { GitRunner } from "../../git/runner.ts";
import {
	AuthenticationError,
	DependencyError,
	FRIENDLY_ERRORS,
	GithubApiError,
	GitMutationError,
	GitRepositoryError,
	PiOmpGitError,
	PrCheckoutConflictError,
	ResourceNotFoundError,
	WorktreeCollisionError,
} from "../../shared/errors.ts";
import {
	CommandNotFoundError,
	type RunResult,
} from "../../shared/subprocess.ts";
import {
	checkPrUrlRepoConflict,
	type PrIdentifier,
	parsePrIdentifier,
} from "../pr-ref.ts";
import { parseGitRemoteUrl, resolveCurrentGithubRepo } from "../repo.ts";
import type { GhRunner } from "../runner.ts";

/** Worktree suffix attempts before the collision error (§27, bounded). */
const MAX_WORKTREE_SUFFIXES = 100;
/** Bounded attempts for a distinct `fork-<owner>-N` remote name (§29). */
const MAX_FORK_REMOTE_SUFFIXES = 9;

/** `gh pr view --json` fields for checkout (headRefOid dropped on legacy retry). */
export const PR_VIEW_FIELDS = [
	"number",
	"url",
	"title",
	"state",
	"headRefName",
	"headRefOid",
	"headRepository",
	"headRepositoryOwner",
	"isCrossRepository",
	"maintainerCanModify",
] as const;

export const PR_VIEW_FIELDS_LEGACY = PR_VIEW_FIELDS.filter(
	(field) => field !== "headRefOid",
);

export interface PrCheckoutDeps {
	gh: GhRunner;
	git: GitRunner;
	env: NodeJS.ProcessEnv;
	/** Absolute managed-worktree root (config-resolved). */
	getWorktreeRoot: () => string;
	/** Shared-repository mutation lock (§31). */
	mutationLock: RepositoryMutationLock;
	/** Primary checkout directory; the runner default when omitted. */
	cwd?: string;
}

export interface PrCheckoutTarget {
	pr: string | string[];
	force?: boolean;
	repo?: string;
}

export interface PrCheckoutItem {
	/** The identifier exactly as provided. */
	pr: string;
	number: number;
	branch: string;
	worktreePath: string;
	/** True when the branch already existed at the correct SHA. */
	reused: boolean;
	url?: string;
	headRef?: string;
	crossRepository?: boolean;
	/** The remote serving the PR head (fetch and push). */
	headRemote?: string;
}

export type PrFailureClassification =
	| "unavailable"
	| "authentication"
	| "repo-resolution"
	| "api"
	| "invalid-identifier"
	| "not-found"
	| "checkout-conflict"
	| "metadata-missing"
	| "worktree-collision"
	| "git-repository"
	| "git-mutation"
	| "unknown";

export interface PrCheckoutFailure {
	pr: string;
	classification: PrFailureClassification;
	error: string;
}

export interface PrCheckoutOutcome {
	checkouts: PrCheckoutItem[];
	failures: PrCheckoutFailure[];
}

/** Every requested PR failed — the §24/D4 structured error. */
export class PrCheckoutBatchError extends PiOmpGitError {
	constructor(
		message: string,
		public readonly outcome: PrCheckoutOutcome,
	) {
		super(message);
	}
}

/** Map a thrown error into the §90 error class the failures[] carry. */
export function classifyCheckoutFailure(
	error: unknown,
): PrFailureClassification {
	if (error instanceof PrCheckoutConflictError) return "checkout-conflict";
	if (error instanceof WorktreeCollisionError) return "worktree-collision";
	if (error instanceof GitMutationError) return "git-mutation";
	if (error instanceof GitRepositoryError) return "git-repository";
	if (error instanceof ResourceNotFoundError) return "not-found";
	if (error instanceof AuthenticationError) return "authentication";
	if (error instanceof GithubApiError) return "api";
	if (error instanceof DependencyError) return "unavailable";
	if (error instanceof PiOmpGitError) return "unknown";
	return "unknown";
}

function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface PrViewPayload {
	number: number;
	url?: string;
	title?: string;
	state?: string;
	headRefName?: string;
	headRefOid?: string;
	headRepository?: { name?: string; owner?: { login?: string } } | null;
	headRepositoryOwner?: { login?: string } | null;
	isCrossRepository?: boolean;
	maintainerCanModify?: boolean;
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

/** `git rev-parse --show-toplevel` for the primary checkout. */
async function resolveRepoRoot(
	git: GitRunner,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	const result = await runGit(
		git,
		["rev-parse", "--show-toplevel"],
		cwd,
		signal,
	);
	if (result.exitCode !== 0) {
		throw new GitRepositoryError(
			"pr_checkout requires a Git repository; this directory is not inside one.",
		);
	}
	return result.stdout.trim();
}

/** Absolute common Git directory — the §31 lock identity and lockfile home. */
async function resolveCommonGitDir(
	git: GitRunner,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	repoRoot: string,
): Promise<string> {
	const result = await runGit(
		git,
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		cwd,
		signal,
	);
	if (result.exitCode === 0 && result.stdout.trim()) {
		return result.stdout.trim();
	}
	// Older git without --path-format: resolve the relative output.
	const legacy = await runGit(
		git,
		["rev-parse", "--git-common-dir"],
		cwd,
		signal,
	);
	if (legacy.exitCode === 0 && legacy.stdout.trim()) {
		const raw = legacy.stdout.trim();
		return raw.startsWith("/") ? raw : join(repoRoot, raw);
	}
	return join(repoRoot, ".git");
}

/** Build the `gh pr view` argv (stable across tests and callers). */
export function buildPrViewArgv(
	identifier: string,
	repoScope: string | undefined,
	includeHeadRefOid: boolean,
): string[] {
	const fields = (
		includeHeadRefOid ? PR_VIEW_FIELDS : PR_VIEW_FIELDS_LEGACY
	).join(",");
	const argv = ["pr", "view", identifier, "--json", fields];
	if (repoScope) argv.push("-R", repoScope);
	return argv;
}

/** Parse the `gh pr view` payload defensively (older/younger gh shapes). */
export function parsePrViewPayload(stdout: string): PrViewPayload {
	const parsed: unknown = JSON.parse(stdout);
	if (!parsed || typeof parsed !== "object") {
		throw new GithubApiError("gh returned an unexpected pull request payload.");
	}
	const record = parsed as Record<string, unknown>;
	const number = record.number;
	if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
		throw new GithubApiError(
			"gh returned a pull request payload without a usable number.",
		);
	}
	const headRepository = (record.headRepository ?? null) as {
		name?: unknown;
		owner?: { login?: unknown } | null;
	} | null;
	const headRepositoryOwner = (record.headRepositoryOwner ?? null) as {
		login?: unknown;
	} | null;
	return {
		number,
		url: typeof record.url === "string" ? record.url : undefined,
		title: typeof record.title === "string" ? record.title : undefined,
		state: typeof record.state === "string" ? record.state : undefined,
		headRefName:
			typeof record.headRefName === "string" ? record.headRefName : undefined,
		headRefOid:
			typeof record.headRefOid === "string" ? record.headRefOid : undefined,
		headRepository: headRepository
			? {
					name:
						typeof headRepository.name === "string"
							? headRepository.name
							: undefined,
					owner: headRepository.owner?.login
						? { login: String(headRepository.owner.login) }
						: undefined,
				}
			: undefined,
		headRepositoryOwner: headRepositoryOwner?.login
			? { login: String(headRepositoryOwner.login) }
			: undefined,
		isCrossRepository:
			typeof record.isCrossRepository === "boolean"
				? record.isCrossRepository
				: undefined,
		maintainerCanModify:
			typeof record.maintainerCanModify === "boolean"
				? record.maintainerCanModify
				: undefined,
	};
}

/** Classify a failed `gh pr view` into the stable taxonomy. */
export function classifyPrViewFailure(result: RunResult): PiOmpGitError {
	const stderr = result.stderr.toLowerCase();
	if (/unknown json field/.test(stderr)) {
		return new GithubApiError("gh does not support a requested JSON field.");
	}
	if (
		/not authenticated|bad credentials|authentication|auth login/.test(stderr)
	) {
		return new AuthenticationError();
	}
	if (/rate limit/i.test(stderr)) {
		return new GithubApiError(
			"GitHub API rate limit exceeded. The limit resets after a wait; retry later.",
		);
	}
	if (
		/could not resolve to a pull request|no pull requests? found|not found|has no pull request/.test(
			stderr,
		)
	) {
		return new ResourceNotFoundError(
			"The pull request could not be found on the host.",
		);
	}
	const detail = firstBoundedLine(result.stderr);
	return new GithubApiError(
		detail
			? `Reading the pull request failed: ${detail}`
			: `Reading the pull request failed with exit code ${result.exitCode ?? "signal"}.`,
	);
}

function firstBoundedLine(text: string, cap = 300): string {
	const line = text
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0);
	if (!line) return "";
	return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

export interface WorktreeEntry {
	path: string;
	head?: string;
	branch?: string;
}

/** Parse `git worktree list --porcelain` output. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | undefined;
	for (const line of porcelain.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current) entries.push(current);
			current = { path: line.slice("worktree ".length) };
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length);
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length);
		}
		// `bare` and `detached` need no fields beyond the defaults.
	}
	if (current) entries.push(current);
	return entries;
}

/** 7-char SHA-256 slice of the primary repository root (§26 naming). */
export function repoRootHash(repoRoot: string): string {
	return createHash("sha256")
		.update(repoRoot, "utf8")
		.digest("hex")
		.slice(0, 7);
}

/** The preferred parity-style worktree name: `<number>-<7-char-hash>` (§26). */
export function worktreeName(number: number, repoRoot: string): string {
	return `${number}-${repoRootHash(repoRoot)}`;
}

/**
 * Resolve the push-capable head-repository remote for a fork PR (§29):
 * reuse an existing remote already pointing at the head repository;
 * otherwise add `fork-<owner>` (suffixed when the name is taken), with
 * the clone URL matching the transport origin already uses.
 */
export async function resolveForkRemote(
	git: GitRunner,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	head: { host: string; owner: string; name: string },
): Promise<string> {
	const remotes = await listRemotes(git, cwd, signal);

	const normalize = (url: string): string => {
		const parsed = parseGitRemoteUrl(url);
		if (!parsed) return "";
		return `${(parsed.host ?? "").toLowerCase()}/${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}`;
	};
	const target = `${head.host.toLowerCase()}/${head.owner.toLowerCase()}/${head.name.toLowerCase()}`;

	for (const remote of remotes) {
		if (remote.pushUrl && normalize(remote.pushUrl) === target) {
			return remote.name;
		}
	}
	for (const remote of remotes) {
		if (normalize(remote.fetchUrl) === target) {
			return remote.name;
		}
	}

	const cloneUrl = await forkCloneUrl(git, cwd, signal, head);
	const candidates = [`fork-${head.owner}`];
	for (let index = 2; index <= 1 + MAX_FORK_REMOTE_SUFFIXES; index += 1) {
		candidates.push(`fork-${head.owner}-${index}`);
	}
	for (const name of candidates) {
		if (remotes.some((remote) => remote.name === name)) continue;
		const added = await runGit(
			git,
			["remote", "add", name, cloneUrl],
			cwd,
			signal,
		).then(
			(result) => result.exitCode === 0,
			() => false,
		);
		if (added) return name;
	}
	throw new GitRepositoryError(
		`Could not add a push-capable remote for ${head.owner}/${head.name}: every fork-<owner> name is taken by a different repository.`,
	);
}

/** The head-repository clone URL matching the transport origin already uses. */
async function forkCloneUrl(
	git: GitRunner,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	head: { host: string; owner: string; name: string },
): Promise<string> {
	const origin = await runGit(
		git,
		["remote", "get-url", "origin"],
		cwd,
		signal,
	);
	let transport: "ssh" | "https" = "https";
	if (origin.exitCode === 0) {
		const trimmed = origin.stdout.trim();
		if (trimmed.startsWith("git@")) transport = "ssh";
		else if (trimmed.startsWith("ssh://")) transport = "ssh";
	}
	if (transport === "ssh") {
		return `git@${head.host}:${head.owner}/${head.name}.git`;
	}
	return `https://${head.host}/${head.owner}/${head.name}.git`;
}

interface RemoteListing {
	name: string;
	fetchUrl: string;
	pushUrl?: string;
}

async function listRemotes(
	git: GitRunner,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<RemoteListing[]> {
	const result = await runGit(git, ["remote", "-v"], cwd, signal);
	if (result.exitCode !== 0) {
		throw new GitRepositoryError("Reading the repository remotes failed.");
	}
	const remotes = new Map<string, RemoteListing>();
	for (const line of result.stdout.split("\n")) {
		const match = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(line.trim());
		if (!match) continue;
		const name = match[1] ?? "";
		const url = match[2] ?? "";
		const existing = remotes.get(name) ?? { name, fetchUrl: "" };
		if (match[3] === "push") existing.pushUrl = url;
		else existing.fetchUrl = url;
		remotes.set(name, existing);
	}
	return [...remotes.values()];
}

/**
 * The core git mutation sequence for one PR, executed under the mutation
 * lock. Runs from the primary checkout.
 */
async function checkoutOne(
	deps: PrCheckoutDeps,
	lockIdentity: string,
	identifier: string,
	repoRoot: string,
	target: PrCheckoutTarget,
	signal: AbortSignal | undefined,
): Promise<PrCheckoutItem> {
	const parsed = parsePrIdentifier(identifier);
	if (!parsed) {
		throw new PiOmpGitError(
			`Invalid PR identifier: ${identifier}. Use a PR number as text, a PR URL, or a branch-like identifier.`,
		);
	}
	checkPrUrlRepoConflict(parsed, target.repo);

	const { payload, headRefOidProvided } = await fetchPrPayload(
		deps,
		parsed,
		target.repo,
		signal,
	);

	const headRefName = payload.headRefName ?? `pull/${payload.number}/head`;
	const baseIdentity = await resolveBaseIdentity(
		deps,
		parsed,
		target.repo,
		signal,
	);
	const pullUrl =
		payload.url ??
		`https://${baseIdentity.host}/${baseIdentity.owner}/${baseIdentity.repo}/pull/${payload.number}`;
	const headOwner =
		payload.headRepositoryOwner?.login ?? payload.headRepository?.owner?.login;
	const headRepoName = payload.headRepository?.name;
	const crossRepository =
		payload.isCrossRepository ??
		Boolean(
			headOwner &&
				headRepoName &&
				(headOwner.toLowerCase() !== baseIdentity.owner.toLowerCase() ||
					headRepoName.toLowerCase() !== baseIdentity.repo.toLowerCase()),
		);
	const maintainerCanModify = payload.maintainerCanModify ?? false;

	const branch = `pr-${payload.number}`;

	// The lock guards every shared-metadata mutation below (§31).
	return deps.mutationLock.withLock(lockIdentity, async () => {
		// 1. Materialize the PR head commit locally.
		let fetchRemote = "origin";
		if (crossRepository && headOwner && headRepoName) {
			fetchRemote = await resolveForkRemote(deps.git, deps.cwd, signal, {
				host: baseIdentity.host,
				owner: headOwner,
				name: headRepoName,
			});
			const fetched = await runGit(
				deps.git,
				["fetch", fetchRemote, headRefName],
				deps.cwd,
				signal,
			);
			if (fetched.exitCode !== 0) {
				throw new GitRepositoryError(
					`Fetching the fork branch ${headRefName} from ${fetchRemote} failed: ${firstBoundedLine(fetched.stderr)}`,
				);
			}
		} else {
			const fetched = await runGit(
				deps.git,
				["fetch", "origin", `pull/${payload.number}/head`],
				deps.cwd,
				signal,
			);
			if (fetched.exitCode !== 0) {
				throw new GitRepositoryError(
					`Fetching pull/${payload.number}/head from origin failed: ${firstBoundedLine(fetched.stderr)}`,
				);
			}
		}

		const headSha =
			headRefOidProvided && payload.headRefOid
				? payload.headRefOid
				: await resolveFetchedHead(deps.git, deps.cwd, signal);

		// 2. Existing local branch (§28) — reuse, conflict, or forced reset.
		const existing = await branchSha(deps.git, branch, deps.cwd, signal);
		let branchReused = false;
		if (existing && existing !== headSha) {
			if (!target.force) {
				throw new PrCheckoutConflictError(
					`Branch ${branch} exists at ${existing.slice(0, 12)} but pull request ` +
						`${payload.number}'s head is ${headSha.slice(0, 12)}. A silent reset is never ` +
						"performed (divergence D2) — pass force: true to reset the local branch to the PR head.",
				);
			}
			await forceResetBranch(deps.git, branch, headSha, deps.cwd, signal);
		} else if (existing) {
			branchReused = true;
		}

		// 3. Existing worktree detection keys on the branch reference (§27).
		const worktrees = await listWorktrees(deps.git, deps.cwd, signal);
		const existingEntry = worktrees.find(
			(entry) => entry.branch === `refs/heads/${branch}`,
		);

		let worktreePath: string;
		if (existingEntry && existsSync(existingEntry.path)) {
			worktreePath = existingEntry.path;
		} else {
			if (existingEntry) {
				// Stale metadata: prune administrative entries, then create.
				const pruned = await runGit(
					deps.git,
					["worktree", "prune"],
					deps.cwd,
					signal,
				);
				if (pruned.exitCode !== 0) {
					throw new GitRepositoryError(
						`Pruning stale worktree metadata failed: ${firstBoundedLine(pruned.stderr)}`,
					);
				}
			}
			worktreePath = await allocateWorktreePath(
				deps.git,
				deps.getWorktreeRoot(),
				payload.number,
				repoRoot,
				deps.cwd,
				signal,
			);
			const branchExists = Boolean(existing);
			const added = branchExists
				? await runGit(
						deps.git,
						["worktree", "add", worktreePath, branch],
						deps.cwd,
						signal,
					)
				: await runGit(
						deps.git,
						["worktree", "add", worktreePath, "-b", branch, headSha],
						deps.cwd,
						signal,
					);
			if (added.exitCode !== 0) {
				throw new GitRepositoryError(
					`Creating the managed worktree at ${worktreePath} failed: ${firstBoundedLine(added.stderr)}`,
				);
			}
		}

		// 4. OMP-compatible branch metadata (§30) — the push contract.
		const pushRemote = crossRepository ? fetchRemote : "origin";
		await writeBranchMetadata(deps.git, deps.cwd, signal, {
			branch,
			fetchRemote,
			pushRemote,
			mergeRef: `refs/heads/${headRefName}`,
			headRef: headRefName,
			url: pullUrl,
			crossRepository,
			maintainerCanModify,
		});

		return {
			pr: identifier,
			number: payload.number,
			branch,
			worktreePath,
			reused: branchReused,
			...(pullUrl ? { url: pullUrl } : {}),
			headRef: headRefName,
			crossRepository,
			headRemote: pushRemote,
		};
	});
}

async function resolveFetchedHead(
	git: GitRunner,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	const result = await runGit(git, ["rev-parse", "FETCH_HEAD"], cwd, signal);
	if (result.exitCode !== 0) {
		throw new GitRepositoryError(
			"Resolving the fetched pull request head failed.",
		);
	}
	return result.stdout.trim();
}

async function branchSha(
	git: GitRunner,
	branch: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	const result = await runGit(
		git,
		["rev-parse", "--verify", `refs/heads/${branch}`],
		cwd,
		signal,
	);
	if (result.exitCode !== 0) return null;
	return result.stdout.trim();
}

async function listWorktrees(
	git: GitRunner,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<WorktreeEntry[]> {
	const result = await runGit(
		git,
		["worktree", "list", "--porcelain"],
		cwd,
		signal,
	);
	if (result.exitCode !== 0) {
		throw new GitRepositoryError("Listing the repository worktrees failed.");
	}
	return parseWorktreeList(result.stdout);
}

/** Force-reset the local PR branch, in place when a worktree holds it. */
async function forceResetBranch(
	git: GitRunner,
	branch: string,
	headSha: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	const worktrees = await listWorktrees(git, cwd, signal);
	const holder = worktrees.find(
		(entry) => entry.branch === `refs/heads/${branch}`,
	);
	const reset = holder
		? await runGit(
				git,
				["-C", holder.path, "reset", "--hard", headSha],
				cwd,
				signal,
			)
		: await runGit(git, ["branch", "-f", branch, headSha], cwd, signal);
	if (reset.exitCode !== 0) {
		throw new GitMutationError(
			`Force-resetting ${branch} to the PR head failed: ${firstBoundedLine(reset.stderr)}`,
		);
	}
}

async function allocateWorktreePath(
	git: GitRunner,
	root: string,
	number: number,
	repoRoot: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	const worktrees = await listWorktrees(git, cwd, signal);
	mkdirSync(root, { recursive: true });
	const base = worktreeName(number, repoRoot);
	const candidates = [base];
	for (let index = 2; index <= 1 + MAX_WORKTREE_SUFFIXES; index += 1) {
		candidates.push(`${base}-${index}`);
	}
	for (const candidate of candidates) {
		const path = join(root, candidate);
		const occupied =
			existsSync(path) || worktrees.some((entry) => entry.path === path);
		if (!occupied) return path;
	}
	throw new WorktreeCollisionError(
		`No managed worktree path could be allocated for PR ${number} under ${root} after ${MAX_WORKTREE_SUFFIXES} suffixes.`,
	);
}

async function writeBranchMetadata(
	git: GitRunner,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	metadata: {
		branch: string;
		fetchRemote: string;
		pushRemote: string;
		mergeRef: string;
		headRef: string;
		url: string;
		crossRepository: boolean;
		maintainerCanModify: boolean;
	},
): Promise<void> {
	const values: Array<[string, string]> = [
		["remote", metadata.fetchRemote],
		["merge", metadata.mergeRef],
		["pushRemote", metadata.pushRemote],
		["ompPrHeadRef", metadata.headRef],
		["ompPrUrl", metadata.url],
		["ompPrIsCrossRepository", metadata.crossRepository ? "true" : "false"],
		[
			"ompPrMaintainerCanModify",
			metadata.maintainerCanModify ? "true" : "false",
		],
	];
	for (const [key, value] of values) {
		const result = await runGit(
			git,
			["config", `branch.${metadata.branch}.${key}`, value],
			cwd,
			signal,
		);
		if (result.exitCode !== 0) {
			throw new GitRepositoryError(
				`Persisting branch metadata branch.${metadata.branch}.${key} failed: ${firstBoundedLine(result.stderr)}`,
			);
		}
	}
}

interface BaseIdentity {
	host: string;
	owner: string;
	repo: string;
}

async function resolveBaseIdentity(
	deps: PrCheckoutDeps,
	parsed: PrIdentifier,
	explicitRepo: string | undefined,
	signal: AbortSignal | undefined,
): Promise<BaseIdentity> {
	if (parsed.kind === "url") {
		return { host: parsed.host, owner: parsed.owner, repo: parsed.repo };
	}
	if (explicitRepo) {
		const segments = explicitRepo.trim().split("/").filter(Boolean);
		if (segments.length === 3) {
			return {
				host: segments[0] ?? "",
				owner: segments[1] ?? "",
				repo: segments[2] ?? "",
			};
		}
		if (segments.length === 2) {
			return {
				host: deps.env.GH_HOST ?? "github.com",
				owner: segments[0] ?? "",
				repo: segments[1] ?? "",
			};
		}
	}
	const current = await resolveCurrentGithubRepo(
		{ git: deps.git, env: deps.env },
		signal,
	).catch(() => null);
	if (current) return current;
	return { host: deps.env.GH_HOST ?? "github.com", owner: "", repo: "" };
}

/** The text handed to `gh pr view` for one parsed identifier. */
function ghViewArgument(parsed: PrIdentifier): string {
	if (parsed.kind === "number") return String(parsed.number);
	if (parsed.kind === "url") return parsed.url;
	return parsed.ref;
}

async function fetchPrPayload(
	deps: PrCheckoutDeps,
	parsed: PrIdentifier,
	explicitRepo: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ payload: PrViewPayload; headRefOidProvided: boolean }> {
	// A PR URL already names its repository (D3 checked earlier); an
	// explicit scope applies to number and branch-like identifiers.
	const repoScope =
		parsed.kind === "url" ? undefined : (explicitRepo ?? undefined);
	const identifier = ghViewArgument(parsed);
	let result = await runGh(
		deps,
		buildPrViewArgv(identifier, repoScope, true),
		explicitRepo,
		signal,
	);
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toLowerCase();
		if (/unknown json field/.test(stderr) && stderr.includes("headrefoid")) {
			// Older gh: retry with the unsupported field omitted (§17).
			result = await runGh(
				deps,
				buildPrViewArgv(identifier, repoScope, false),
				explicitRepo,
				signal,
			);
			if (result.exitCode !== 0) {
				throw classifyPrViewFailure(result);
			}
			return {
				payload: parsePrViewPayload(result.stdout),
				headRefOidProvided: false,
			};
		}
		throw classifyPrViewFailure(result);
	}
	return {
		payload: parsePrViewPayload(result.stdout),
		headRefOidProvided: true,
	};
}

async function runGh(
	deps: PrCheckoutDeps,
	argv: string[],
	explicitRepo: string | undefined,
	signal: AbortSignal | undefined,
): Promise<RunResult> {
	let host: string | undefined;
	if (explicitRepo) {
		const segments = explicitRepo.trim().split("/").filter(Boolean);
		if (segments.length === 3) host = segments[0];
	}
	try {
		return await deps.gh.run(argv, {
			signal,
			cwd: deps.cwd,
			...(host ? { extraEnv: { GH_HOST: host } } : {}),
		});
	} catch (error) {
		if (error instanceof CommandNotFoundError) {
			throw new DependencyError(FRIENDLY_ERRORS.ghMissing, "gh");
		}
		throw error;
	}
}

/**
 * Check out one or more PRs into managed worktrees (§24, §23).
 * Sequential under the shared mutation lock; every identifier is
 * attempted, and one failure never rolls back unrelated successes.
 */
export async function checkoutPullRequests(
	deps: PrCheckoutDeps,
	target: PrCheckoutTarget,
	signal?: AbortSignal,
): Promise<PrCheckoutOutcome> {
	const identifiers = (Array.isArray(target.pr) ? target.pr : [target.pr])
		.map((value) => value.trim())
		.filter((value) => value !== "");
	if (identifiers.length === 0) {
		throw new PiOmpGitError(
			"The `pr` parameter is required for pr_checkout — a PR number as text, a PR URL, or a branch-like identifier.",
		);
	}

	const repoRoot = await resolveRepoRoot(deps.git, deps.cwd, signal);
	const lockIdentity = await resolveCommonGitDir(
		deps.git,
		deps.cwd,
		signal,
		repoRoot,
	);

	const checkouts: PrCheckoutItem[] = [];
	const failures: PrCheckoutFailure[] = [];
	for (const identifier of identifiers) {
		try {
			checkouts.push(
				await checkoutOne(
					deps,
					lockIdentity,
					identifier,
					repoRoot,
					target,
					signal,
				),
			);
		} catch (error) {
			failures.push({
				pr: identifier,
				classification: classifyCheckoutFailure(error),
				error: failureMessage(error),
			});
		}
	}

	// Divergence D4: a 0-for-N batch checkout is an error carrying the
	// same structured body a partial success would.
	if (failures.length > 0 && checkouts.length === 0) {
		throw new PrCheckoutBatchError(
			renderAllFailuresMessage({ checkouts, failures }),
			{ checkouts, failures },
		);
	}
	return { checkouts, failures };
}

/** Render the batch failure body used for the 0-for-N error (divergence D4). */
export function renderAllFailuresMessage(outcome: PrCheckoutOutcome): string {
	const total = outcome.checkouts.length + outcome.failures.length;
	const lines = [
		`pr_checkout failed for every requested PR (0 of ${total} succeeded).`,
	];
	for (const failure of outcome.failures) {
		lines.push(
			`- PR ${failure.pr} [${failure.classification}]: ${failure.error}`,
		);
	}
	return lines.join("\n");
}

/** Render the tool-facing result body (§24 result shape, worktree prominent). */
export function renderPrCheckout(outcome: PrCheckoutOutcome): string {
	const { checkouts, failures } = outcome;
	const lines: string[] = [];

	const single = checkouts.length === 1 && failures.length === 0;
	const first = checkouts[0];
	if (single && first) {
		lines.push(
			`Checked out PR ${first.number} into a managed worktree.`,
			"",
			`Worktree: ${first.worktreePath}`,
			`Branch:   ${first.branch}${first.reused ? " (reused)" : ""}`,
		);
		if (first.url) lines.push(`PR:       ${first.url}`);
		if (first.headRef) {
			lines.push(
				`Head ref: ${first.headRef}${first.crossRepository ? " (cross-repository)" : ""}`,
			);
		}
		lines.push(
			"",
			"Edit files under the worktree using absolute paths — the session's working directory is unchanged. pr_push and run_watch default to this checkout.",
		);
		return lines.join("\n");
	}

	if (checkouts.length > 0) {
		lines.push(
			failures.length > 0
				? `Checked out ${checkouts.length} PR${checkouts.length === 1 ? "" : "s"}; ${failures.length} failed (partial success).`
				: `Checked out ${checkouts.length} PR${checkouts.length === 1 ? "" : "s"} into managed worktrees.`,
		);
		for (const record of checkouts) {
			lines.push(
				"",
				`PR ${record.number}:`,
				`  Worktree: ${record.worktreePath}`,
				`  Branch:   ${record.branch}${record.reused ? " (reused)" : ""}`,
			);
			if (record.url) lines.push(`  PR:       ${record.url}`);
			if (record.headRef) {
				lines.push(
					`  Head ref: ${record.headRef}${record.crossRepository ? " (cross-repository)" : ""}`,
				);
			}
		}
	}
	if (failures.length > 0) {
		lines.push("", "Failures:");
		for (const failure of failures) {
			lines.push(
				`- PR ${failure.pr} [${failure.classification}]: ${failure.error}`,
			);
		}
	}
	if (checkouts.length > 0) {
		lines.push(
			"",
			"Edit files under the worktrees using absolute paths — the session's working directory is unchanged. pr_push and run_watch default to the last checkout.",
		);
	}
	return lines.join("\n");
}
