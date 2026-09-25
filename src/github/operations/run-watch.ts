/**
 * `run_watch` — GitHub Actions watching (docs/pi-omp-git-reference.md
 * §40–§45, tickets 15–16).
 *
 * Run mode watches one run ID or Actions URL to completion; commit mode
 * discovers all workflow runs for a commit SHA (SHA-oriented, so
 * PR- and tag-triggered workflows are found) and aggregates their
 * outcomes. The polling engine uses the parity cadences with an
 * injected clock — tests never sleep — and honors the tool's
 * AbortSignal, terminating in-flight `gh` processes on cancellation.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { GitRunner } from "../../git/runner.ts";
import {
	ActionsRateLimitError,
	ActionsWatchError,
	PiOmpGitError,
} from "../../shared/errors.ts";
import type { CheckoutRecord } from "../last-checkout.ts";
import { resolveCurrentGithubRepo } from "../repo.ts";
import type { GhRunner } from "../runner.ts";
import { GithubParamsError, optionalNonEmptyString } from "./params.ts";
import {
	type CommitShaSourcePlan,
	type GithubRepoIdentity,
	planCommitShaSource,
	planWatchTarget,
} from "./planning.ts";

/** Poll cadences and budgets — parity values from §41. */
export const FAST_POLL_INTERVAL_MS = 3_000;
export const FAST_POLL_WINDOW_MS = 60_000;
export const SLOW_POLL_INTERVAL_MS = 15_000;
export const NO_RUNS_TIMEOUT_MS = 90_000;
export const MAX_POLL_FAILURES = 5;
export const FAILURE_GRACE_MS = 5_000;

/** §44 log-tail defaults. */
export const DEFAULT_LOG_TAIL_LINES = 15;
export const MAX_LOG_TAIL_LINES = 200;

/** §42 completion semantics. */
const SUCCESSFUL_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILURE_CONCLUSIONS = new Set([
	"failure",
	"timed_out",
	"cancelled",
	"action_required",
	"startup_failure",
]);

export function isSuccessfulConclusion(conclusion: string | null): boolean {
	return conclusion === null
		? false
		: SUCCESSFUL_CONCLUSIONS.has(conclusion.toLowerCase());
}

export function isFailureConclusion(conclusion: string | null): boolean {
	return conclusion === null
		? false
		: FAILURE_CONCLUSIONS.has(conclusion.toLowerCase());
}

/**
 * Injected time source: polls, cadence switching, timeouts, and the
 * stabilization/grace waits all read through this seam so tests drive
 * virtual time instead of sleeping (§98).
 */
export interface WatchClock {
	now(): number;
	/** Rejects when the signal aborts; real implementations kill the wait. */
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function createRealWatchClock(): WatchClock {
	return {
		now: () => Date.now(),
		sleep(ms, signal) {
			return new Promise<void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(signal.reason ?? new Error("aborted"));
					return;
				}
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				}, ms);
				const onAbort = () => {
					clearTimeout(timer);
					reject(signal?.reason ?? new Error("aborted"));
				};
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
	};
}

/** One watched run and, once fetched, its jobs. */
export interface RunWatchRunState {
	id?: number;
	workflow?: string;
	title?: string;
	headBranch?: string;
	headSha?: string;
	status?: string;
	conclusion?: string | null;
	url?: string;
	jobs?: RunWatchJobState[];
}

export interface RunWatchJobState {
	id?: number | null;
	name?: string;
	status?: string;
	conclusion?: string | null;
	url?: string;
	/** Inline tail of the captured log (failed jobs only, §44). */
	logTail?: string;
	/** Persisted full-log artifact path (failed jobs only, §44). */
	logArtifact?: string;
	/** The log download failed; the watch itself did not (§44). */
	logUnavailable?: boolean;
}

export interface RunWatchDetails {
	op: "run_watch";
	repo: string;
	/** Run mode: the watched run ID. */
	run?: number;
	/** Commit mode: the watched commit SHA. */
	commit?: string;
	/** Progress phase while streaming (§45). */
	status?: string;
	/** Elapsed watch time in whole seconds. */
	elapsedSeconds?: number;
	runs?: RunWatchRunState[];
	/** The final outcome classification. */
	outcome?: "success" | "failure" | "no-runs";
}

export interface RunWatchTarget {
	/** Run ID as text or a GitHub Actions run URL (run mode). */
	run?: string;
	/** Explicit commit SHA (commit mode). */
	commit?: string;
	/** Explicit PR identifier (commit mode; resolved to its head SHA). */
	pr?: string;
	/** Explicit repository identifier (owner/repo or host/owner/repo). */
	repo?: string;
	/** Inline log-tail line count for failed jobs (§44). */
	tail?: number;
}

export const RUN_WATCH_OPERATION_PARAMETERS = Type.Object({
	op: Type.Literal("run_watch"),
	run: Type.Optional(Type.String()),
	commit: Type.Optional(Type.String()),
	pr: Type.Optional(Type.String()),
	repo: Type.Optional(Type.String()),
	tail: Type.Optional(Type.Number()),
});

export type RunWatchOperationArguments = Static<
	typeof RUN_WATCH_OPERATION_PARAMETERS
>;

export function validateRunWatchOperationArguments(
	params: Record<string, unknown>,
): RunWatchOperationArguments {
	const rawPr = params.pr;
	if (Array.isArray(rawPr)) {
		throw new GithubParamsError(
			"run_watch accepts a single PR; the array form of `pr` is valid for pr_checkout batching only.",
		);
	}
	const run = optionalNonEmptyString(params, "run");
	const commit = optionalNonEmptyString(params, "commit");
	const pr = optionalNonEmptyString(params, "pr");
	const repo = optionalNonEmptyString(params, "repo");
	if (run !== undefined && (commit !== undefined || pr !== undefined)) {
		throw new GithubParamsError(
			"run_watch accepts either `run` (run mode) or `commit`/`pr` (commit mode), not both.",
		);
	}
	const rawTail = params.tail;
	let tail: number | undefined;
	if (rawTail !== undefined && rawTail !== null) {
		if (
			typeof rawTail !== "number" ||
			!Number.isFinite(rawTail) ||
			rawTail <= 0
		) {
			throw new GithubParamsError(
				"The `tail` parameter must be a positive number of log lines (max 200).",
			);
		}
		tail = Math.min(200, Math.floor(rawTail));
	}
	return {
		op: "run_watch",
		...(run !== undefined ? { run } : {}),
		...(commit !== undefined ? { commit } : {}),
		...(pr !== undefined ? { pr } : {}),
		...(repo !== undefined ? { repo } : {}),
		...(tail !== undefined ? { tail } : {}),
	};
}

export interface RunWatchDeps {
	gh: GhRunner;
	git: GitRunner;
	/** gh host fallback resolution (GH_HOST, §47). */
	env: NodeJS.ProcessEnv;
	/** The session working directory (current-HEAD resolution, §110). */
	cwd: string;
	/** The session's last checkout (commit-mode SHA resolution, §110). */
	getLastCheckout?: () => CheckoutRecord | null;
	clock?: WatchClock;
	/** Where captured logs persist (§44); test seam overrides the default. */
	artifactsDir?: string;
	signal?: AbortSignal;
	/** Streaming progress updates (§45). */
	onUpdate?: (details: RunWatchDetails) => void;
}

interface RunViewPayload {
	databaseId?: number;
	status?: string;
	conclusion?: string | null;
	displayTitle?: string;
	workflowName?: string;
	headBranch?: string;
	headSha?: string;
	url?: string;
	jobs?: Array<{
		databaseId?: number | null;
		name?: string;
		status?: string;
		conclusion?: string | null;
		url?: string;
	}>;
}

interface RunListPayload {
	databaseId?: number;
	status?: string;
	conclusion?: string | null;
	displayTitle?: string;
	workflowName?: string;
	headBranch?: string;
	headSha?: string;
	url?: string;
	jobs?: RunViewPayload["jobs"];
}

const RUN_VIEW_FIELDS =
	"status,conclusion,displayTitle,workflowName,headBranch,headSha,url,jobs,databaseId";
const RUN_LIST_FIELDS =
	"databaseId,status,conclusion,displayTitle,workflowName,headBranch,headSha,url";

function ghJson<T>(stdout: string, context: string): T {
	try {
		return JSON.parse(stdout) as T;
	} catch {
		throw new ActionsWatchError(`${context}: gh returned invalid JSON.`);
	}
}

function isRateLimitStderr(stderr: string): boolean {
	return /rate limit/i.test(stderr);
}

/** The poll interval at a given elapsed watch time (§41 cadences). */
export function pollIntervalMs(elapsedMs: number): number {
	return elapsedMs < FAST_POLL_WINDOW_MS
		? FAST_POLL_INTERVAL_MS
		: SLOW_POLL_INTERVAL_MS;
}

function sanitizeFileComponent(text: string): string {
	return (
		text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "job"
	);
}

function tailLines(text: string, lines: number): string {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
	const all = normalized === "" ? [] : normalized.split("\n");
	return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/**
 * Watch Actions for a run or a commit. See §40–§45 for the behavioral
 * contract; the module constants list the cadences.
 */
export async function watchActions(
	deps: RunWatchDeps,
	target: RunWatchTarget,
): Promise<{
	outcome: RunWatchDetails["outcome"];
	text: string;
	details: RunWatchDetails;
}> {
	const clock = deps.clock ?? createRealWatchClock();
	const signal = deps.signal;
	const startedAt = clock.now();
	const state = new Map<number, RunWatchRunState>();
	let consecutiveFailures = 0;
	let graceApplied = false;

	const emit = (status: string): void => {
		deps.onUpdate?.({
			op: "run_watch",
			repo: repoLabel,
			...(mode === "run" ? { run: runNumber ?? undefined } : {}),
			...(mode === "commit" ? { commit: commitSha ?? undefined } : {}),
			status,
			elapsedSeconds: Math.max(0, Math.round((clock.now() - startedAt) / 1000)),
			runs: [...state.values()].map((run) => ({ ...run })),
		});
	};

	const runGh = async (args: string[], context: string): Promise<string> => {
		const result = await deps.gh.run(args, { signal, cwd: deps.cwd });
		if (result.exitCode !== 0) {
			if (result.cancelled || signal?.aborted) {
				signal?.throwIfAborted();
			}
			const detail = (result.stderr || result.stdout).trim().slice(0, 300);
			const failure = new ActionsWatchError(
				`${context}: gh exited ${result.exitCode}${detail ? ` — ${detail}` : ""}`,
			);
			(failure as ActionsWatchError & { stderr?: string }).stderr =
				result.stderr;
			throw failure;
		}
		return result.stdout;
	};

	const recordPollFailure = (error: unknown): void => {
		consecutiveFailures += 1;
		if (consecutiveFailures < MAX_POLL_FAILURES) return;
		const stderr = String((error as { stderr?: string })?.stderr ?? "");
		if (isRateLimitStderr(stderr)) {
			throw new ActionsRateLimitError(
				`GitHub Actions polling kept hitting the rate limit (${MAX_POLL_FAILURES} consecutive poll failures).`,
			);
		}
		throw error instanceof PiOmpGitError
			? error
			: new ActionsWatchError(
					`GitHub Actions polling failed ${MAX_POLL_FAILURES} times in a row: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
	};

	// ---- target resolution ---------------------------------------------
	const plan = planWatchTarget(target);
	const mode: "run" | "commit" = plan.mode;
	let repoLabel: string;
	let identity: GithubRepoIdentity | null = null;
	let runNumber: number | null = null;
	let commitSha: string | null = null;

	if (plan.mode === "run") {
		runNumber = plan.runNumber ?? null;
		if (plan.urlIdentity) identity = plan.urlIdentity;
	} else {
		commitSha = await resolveCommitSha(deps, target);
	}

	if (!identity) {
		identity =
			plan.repoIdentity ?? (await resolveCurrentGithubRepo(deps, signal));
	}
	repoLabel = `${identity.owner}/${identity.repo}`;
	const repoFlag = ["-R", repoLabel] as const;

	const fetchRunView = async (runId: number): Promise<RunViewPayload> => {
		const stdout = await runGh(
			["run", "view", String(runId), ...repoFlag, "--json", RUN_VIEW_FIELDS],
			`run ${runId}`,
		);
		return ghJson<RunViewPayload>(stdout, `run ${runId}`);
	};

	const listRunsForCommit = async (sha: string): Promise<RunListPayload[]> => {
		const stdout = await runGh(
			[
				"run",
				"list",
				...repoFlag,
				"--commit",
				sha,
				"--json",
				RUN_LIST_FIELDS,
				"--limit",
				"50",
			],
			`runs for ${sha.slice(0, 12)}`,
		);
		const parsed = ghJson<RunListPayload[]>(stdout, `runs for ${sha}`);
		return Array.isArray(parsed) ? parsed : [];
	};

	const mergeRunPayload = (
		payload: RunListPayload | RunViewPayload,
		fallbackId?: number,
	): void => {
		const id = payload.databaseId ?? fallbackId;
		if (typeof id !== "number") return;
		const existing = state.get(id) ?? { id };
		state.set(id, {
			...existing,
			id,
			...(payload.workflowName !== undefined
				? { workflow: payload.workflowName }
				: {}),
			...(payload.displayTitle !== undefined
				? { title: payload.displayTitle }
				: {}),
			...(payload.headBranch !== undefined
				? { headBranch: payload.headBranch }
				: {}),
			...(payload.headSha !== undefined ? { headSha: payload.headSha } : {}),
			...(payload.status !== undefined ? { status: payload.status } : {}),
			...(payload.conclusion !== undefined
				? { conclusion: payload.conclusion }
				: {}),
			...(payload.url !== undefined ? { url: payload.url } : {}),
			...(payload.jobs !== undefined
				? {
						jobs: payload.jobs.map((job) => ({
							id: job.databaseId ?? null,
							name: job.name,
							status: job.status,
							conclusion: job.conclusion ?? null,
							url: job.url,
						})),
					}
				: {}),
		});
	};

	const isTerminal = (run: RunWatchRunState): boolean =>
		run.status?.toLowerCase() === "completed";

	const hasFailedRun = (): boolean =>
		[...state.values()].some(
			(run) =>
				isFailureConclusion(run.conclusion ?? null) ||
				(run.jobs ?? []).some((job) =>
					isFailureConclusion(job.conclusion ?? null),
				),
		);

	// ---- the polling loop ----------------------------------------------
	if (mode === "run" && runNumber !== null) {
		// Seed the known run so the loop watches it even if a payload omits
		// its own databaseId.
		state.set(runNumber, { id: runNumber });
	}
	emit("started");
	for (;;) {
		signal?.throwIfAborted();
		try {
			if (mode === "commit" && commitSha) {
				const listed = await listRunsForCommit(commitSha);
				for (const payload of listed) mergeRunPayload(payload);
				if (state.size === 0 && clock.now() - startedAt >= NO_RUNS_TIMEOUT_MS) {
					return {
						outcome: "no-runs",
						text: `No workflow runs found for commit ${commitSha.slice(0, 12)} in ${repoLabel} within 90 seconds.`,
						details: {
							op: "run_watch",
							repo: repoLabel,
							commit: commitSha,
							outcome: "no-runs",
							elapsedSeconds: Math.round((clock.now() - startedAt) / 1000),
							runs: [],
						},
					};
				}
			}
			for (const run of state.values()) {
				if (!run.id) continue;
				// Terminal runs are final; failed runs' jobs are refreshed
				// once by the final collection (§44), not every poll.
				if (isTerminal(run)) continue;
				mergeRunPayload(await fetchRunView(run.id), run.id);
			}
		} catch (error) {
			if (
				error instanceof PiOmpGitError &&
				!(error instanceof ActionsWatchError)
			) {
				throw error;
			}
			recordPollFailure(error);
			emit("poll-failure");
			await clock.sleep(pollIntervalMs(clock.now() - startedAt), signal);
			continue;
		}
		consecutiveFailures = 0;

		const runs = [...state.values()];
		const anyFailed = hasFailedRun();
		const allTerminal = runs.length > 0 && runs.every(isTerminal);

		if (anyFailed && !graceApplied && !allTerminal) {
			// §42: failure visible immediately, then the grace period and a
			// refetch collect contemporaneous failures together.
			graceApplied = true;
			emit("failure-detected");
			await clock.sleep(FAILURE_GRACE_MS, signal);
			signal?.throwIfAborted();
			for (const run of state.values()) {
				if (!run.id) continue;
				try {
					mergeRunPayload(await fetchRunView(run.id), run.id);
				} catch (error) {
					recordPollFailure(error);
				}
			}
			emit("failure-refetched");
			continue;
		}

		if (allTerminal) {
			if (mode === "commit" && !anyFailed) {
				// §43 late-run stabilization: one extra interval, then refetch;
				// success only if no new runs appeared and all remain green.
				const knownIds = runs.map((run) => run.id ?? -1);
				emit("stabilizing");
				await clock.sleep(pollIntervalMs(clock.now() - startedAt), signal);
				signal?.throwIfAborted();
				if (commitSha) {
					try {
						const listed = await listRunsForCommit(commitSha);
						for (const payload of listed) mergeRunPayload(payload);
					} catch (error) {
						recordPollFailure(error);
					}
				}
				const after = [...state.values()];
				const newRuns = after.filter(
					(run) => run.id !== undefined && !knownIds.includes(run.id),
				);
				const stillGreen = after.every((run) =>
					isSuccessfulConclusion(run.conclusion ?? null),
				);
				if (newRuns.length > 0 || !stillGreen) continue;
			}
			const outcome: "success" | "failure" = anyFailed ? "failure" : "success";
			const finalRuns = await collectFinalRuns(
				deps.gh,
				{
					identity,
					signal,
					cwd: deps.cwd,
					artifactsDir: deps.artifactsDir,
				},
				runs,
				target.tail ?? DEFAULT_LOG_TAIL_LINES,
			);
			emit(outcome);
			const elapsed = Math.round((clock.now() - startedAt) / 1000);
			return {
				outcome,
				text: renderWatchResult({
					repo: repoLabel,
					mode,
					run: runNumber,
					commit: commitSha,
					outcome,
					runs: finalRuns,
					elapsedSeconds: elapsed,
				}),
				details: {
					op: "run_watch",
					repo: repoLabel,
					...(mode === "run" ? { run: runNumber ?? undefined } : {}),
					...(mode === "commit" ? { commit: commitSha ?? undefined } : {}),
					outcome,
					elapsedSeconds: elapsed,
					runs: finalRuns,
				},
			};
		}

		emit("polling");
		await clock.sleep(pollIntervalMs(clock.now() - startedAt), signal);
	}
}

/** Resolve the commit SHA for commit mode (§40, §110). */
async function resolveCommitSha(
	deps: RunWatchDeps,
	target: RunWatchTarget,
): Promise<string> {
	const source: CommitShaSourcePlan = planCommitShaSource({
		commit: target.commit,
		pr: target.pr,
		lastBranch: deps.getLastCheckout?.()?.branch ?? null,
	});
	if (source.kind === "commit") return source.sha;
	if (source.kind === "pr") {
		const result = await deps.gh.run(
			["pr", "view", source.pr, "--json", "headRefOid"],
			{ signal: deps.signal, cwd: deps.cwd },
		);
		if (result.exitCode !== 0) {
			const detail = (result.stderr || result.stdout).trim().slice(0, 300);
			throw new PiOmpGitError(
				`Could not resolve \`pr\` ${JSON.stringify(target.pr)} to a head SHA${detail ? ` — ${detail}` : ""}.`,
			);
		}
		try {
			const payload = JSON.parse(result.stdout) as { headRefOid?: string };
			if (payload.headRefOid) return payload.headRefOid;
		} catch {
			throw new PiOmpGitError(
				`Could not resolve \`pr\` ${JSON.stringify(target.pr)} to a head SHA — gh returned invalid JSON.`,
			);
		}
	}
	if (source.kind === "last-checkout") {
		const result = await deps.git.run(
			["rev-parse", `refs/heads/${source.branch}`],
			{ signal: deps.signal, cwd: deps.cwd },
		);
		if (result.exitCode === 0 && result.stdout.trim() !== "") {
			return result.stdout.trim();
		}
	}
	const head = await deps.git.run(["rev-parse", "HEAD"], {
		signal: deps.signal,
		cwd: deps.cwd,
	});
	if (head.exitCode !== 0) {
		throw new PiOmpGitError(
			"Could not resolve a commit to watch — pass `commit` or `pr`, or run inside a Git checkout.",
		);
	}
	return head.stdout.trim();
}

/**
 * Final collection: refresh every failed run's jobs and attach log tails
 * and artifact paths for failed jobs (§44). A log-download failure marks
 * the job `logUnavailable` — it never fails the watch.
 */
async function collectFinalRuns(
	gh: GhRunner,
	context: {
		identity: { host: string; owner: string; repo: string };
		signal?: AbortSignal;
		cwd: string;
		artifactsDir?: string;
	},
	runs: RunWatchRunState[],
	tailParam: number | undefined,
): Promise<RunWatchRunState[]> {
	const tail = Math.min(
		MAX_LOG_TAIL_LINES,
		Math.max(1, Math.floor(tailParam ?? DEFAULT_LOG_TAIL_LINES)),
	);
	const artifactsDir =
		context.artifactsDir ?? join(getAgentDir(), "artifacts", "pi-omp-git");
	const finalRuns: RunWatchRunState[] = [];
	for (const run of runs) {
		const next: RunWatchRunState = { ...run };
		if (run.id && isFailureConclusion(run.conclusion ?? null)) {
			next.jobs = await collectFailedJobs(gh, context, run, tail, artifactsDir);
		}
		finalRuns.push(next);
	}
	return finalRuns;
}

async function collectFailedJobs(
	gh: GhRunner,
	context: {
		identity: { host: string; owner: string; repo: string };
		signal?: AbortSignal;
		cwd: string;
	},
	run: RunWatchRunState,
	tail: number,
	artifactsDir: string,
): Promise<RunWatchJobState[]> {
	const jobs: RunWatchJobState[] = (run.jobs ?? []).map((job) => ({ ...job }));
	if (jobs.length === 0 && run.id) {
		// Fetch the run's jobs when the watch never captured them.
		const view = await gh.run(
			[
				"run",
				"view",
				String(run.id),
				"-R",
				`${context.identity.owner}/${context.identity.repo}`,
				"--json",
				RUN_VIEW_FIELDS,
			],
			{ signal: context.signal, cwd: context.cwd },
		);
		if (view.exitCode === 0) {
			try {
				const payload = ghJson<RunViewPayload>(view.stdout, `run ${run.id}`);
				for (const job of payload.jobs ?? []) {
					jobs.push({
						id: job.databaseId ?? null,
						name: job.name,
						status: job.status,
						conclusion: job.conclusion ?? null,
						url: job.url,
					});
				}
			} catch {
				// Leave the job list empty; the outcome still stands.
			}
		}
	}
	for (const job of jobs) {
		if (!isFailureConclusion(job.conclusion ?? null)) continue;
		if (typeof job.id !== "number") {
			job.logUnavailable = true;
			continue;
		}
		const logResult = await gh.run(
			[
				"api",
				`repos/${context.identity.owner}/${context.identity.repo}/actions/jobs/${job.id}/logs`,
			],
			{ signal: context.signal, cwd: context.cwd },
		);
		if (logResult.exitCode !== 0 || logResult.stdout.trim() === "") {
			job.logUnavailable = true;
			continue;
		}
		const artifactPath = join(
			artifactsDir,
			sanitizeFileComponent(
				`${context.identity.owner}-${context.identity.repo}`,
			),
			`run-${run.id}-job-${job.id}-${sanitizeFileComponent(job.name ?? "job")}.log`,
		);
		try {
			mkdirSync(dirname(artifactPath), { recursive: true });
			writeFileSync(artifactPath, logResult.stdout, { mode: 0o600 });
			job.logArtifact = artifactPath;
			job.logTail = tailLines(logResult.stdout, tail);
		} catch {
			job.logUnavailable = true;
		}
	}
	return jobs;
}

function renderWatchResult(input: {
	repo: string;
	mode: "run" | "commit";
	run: number | null;
	commit: string | null;
	outcome: "success" | "failure";
	runs: RunWatchRunState[];
	elapsedSeconds: number;
}): string {
	const lines: string[] = [];
	const target =
		input.mode === "run"
			? `run ${input.run}`
			: `commit ${input.commit?.slice(0, 12) ?? ""}`.trimEnd();
	lines.push(
		`Actions watch ${input.repo} ${target} — ${
			input.outcome === "success" ? "succeeded" : "failed"
		} after ${input.elapsedSeconds}s.`,
	);
	for (const run of input.runs) {
		lines.push(
			`- run ${run.id ?? "?"}${run.workflow ? ` (${run.workflow})` : ""}${
				run.title ? `: ${run.title}` : ""
			} — ${run.conclusion ?? run.status ?? "unknown"}${run.url ? ` — ${run.url}` : ""}`,
		);
		for (const job of run.jobs ?? []) {
			if (!isFailureConclusion(job.conclusion ?? null)) continue;
			lines.push(`  - ${job.name ?? "job"} — ${job.conclusion ?? "failed"}`);
			if (job.logTail !== undefined) {
				lines.push("    log tail:");
				for (const line of job.logTail.split("\n")) {
					lines.push(`      ${line}`);
				}
			}
			if (job.logUnavailable) {
				lines.push("    Log unavailable.");
			}
			if (job.logArtifact) {
				lines.push(`    Full log: ${job.logArtifact}`);
			}
		}
	}
	return lines.join("\n");
}
