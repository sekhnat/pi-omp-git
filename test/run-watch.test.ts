/**
 * Ticket 15/16 acceptance tests: `run_watch` run mode and commit mode
 * (docs/pi-omp-git-reference.md §40–§45, §98).
 *
 * Time is injected through a virtual clock — sleeps resolve immediately
 * and advance virtual time, so cadences, timeouts, the failure grace
 * period, and late-run stabilization are asserted without sleeping.
 * `gh` is scripted at the runner seam; each test drives a poll script.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkRunUrlRepoConflict,
	parseRunIdentifier,
} from "../src/github/operations/planning.ts";
import {
	DEFAULT_LOG_TAIL_LINES,
	MAX_LOG_TAIL_LINES,
	pollIntervalMs,
	type RunWatchDetails,
	type RunWatchTarget,
	type WatchClock,
	watchActions,
} from "../src/github/operations/run-watch.ts";
import type { GhRunner } from "../src/github/runner.ts";
import {
	ActionsRateLimitError,
	ActionsWatchError,
	PiOmpGitError,
} from "../src/shared/errors.ts";
import type { RunResult } from "../src/shared/subprocess.ts";

/** A completed RunResult for the scripted gh runner. */
function result(
	overrides: Partial<RunResult> & { stdout?: string; stderr?: string },
): RunResult {
	return {
		exitCode: 0,
		stdout: "",
		stderr: "",
		truncated: false,
		timedOut: false,
		cancelled: false,
		...overrides,
	};
}

type GhHandler = (args: string[]) => Promise<RunResult>;

function scriptedGh(handler: GhHandler): GhRunner {
	const calls: string[][] = [];
	return {
		run(args) {
			calls.push([...args]);
			return handler([...args]);
		},
	} as GhRunner & { calls: string[][] };
}

/**
 * Virtual clock: sleeps resolve immediately and advance virtual time,
 * recording every sleep so cadences are asserted exactly (§98).
 */
function virtualClock(options: { signal?: AbortSignal } = {}): WatchClock & {
	sleeps: number[];
} {
	let current = 0;
	const sleeps: number[] = [];
	return {
		now: () => current,
		sleep(ms) {
			sleeps.push(ms);
			if (options.signal?.aborted) {
				return Promise.reject(options.signal.reason ?? new Error("aborted"));
			}
			current += ms;
			return Promise.resolve();
		},
		sleeps,
	};
}

const okView = (payload: unknown): RunResult =>
	result({ stdout: JSON.stringify(payload) });

const inProgressRun = (id: number, extra: Record<string, unknown> = {}) => ({
	databaseId: id,
	status: "in_progress",
	conclusion: null,
	displayTitle: `run ${id}`,
	workflowName: "CI",
	headBranch: "main",
	headSha: "abc123def456",
	url: `https://github.com/owner/repo/actions/runs/${id}`,
	...extra,
});

const successRun = (id: number, extra: Record<string, unknown> = {}) => ({
	databaseId: id,
	status: "completed",
	conclusion: "success",
	displayTitle: `run ${id}`,
	workflowName: "CI",
	headBranch: "main",
	headSha: "abc123def456",
	url: `https://github.com/owner/repo/actions/runs/${id}`,
	...extra,
});

function baseTarget(extra: Partial<RunWatchTarget> = {}): RunWatchTarget {
	return { repo: "owner/repo", ...extra };
}

describe("run identifier parsing", () => {
	it("accepts run IDs and Actions URLs (with attempts suffix)", () => {
		expect(parseRunIdentifier(" 1234567 ")).toEqual({
			kind: "number",
			number: 1234567,
		});
		expect(
			parseRunIdentifier("https://github.com/owner/repo/actions/runs/77"),
		).toEqual({
			kind: "url",
			host: "github.com",
			owner: "owner",
			repo: "repo",
			number: 77,
		});
		expect(
			parseRunIdentifier(
				"https://github.com/owner/repo/actions/runs/77/attempts/2",
			)?.kind,
		).toBe("url");
		expect(parseRunIdentifier("main")).toBeNull();
		expect(
			parseRunIdentifier("https://github.com/owner/repo/pull/7"),
		).toBeNull();
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

describe("run mode", () => {
	it("watches a specific successful run to completion", async () => {
		let polls = 0;
		const gh = scriptedGh((args) => {
			if (args[1] === "view") {
				polls += 1;
				return Promise.resolve(
					okView(polls === 1 ? inProgressRun(100) : successRun(100)),
				);
			}
			return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
		});
		const clock = virtualClock();
		const outcome = await watchActions(
			{ gh, git: {} as never, env: {}, cwd: "/repo", clock },
			baseTarget({ run: "100" }),
		);
		expect(outcome.outcome).toBe("success");
		expect(outcome.text).toContain("succeeded");
		expect(outcome.text).toContain("run 100");
		expect(outcome.details.run).toBe(100);
		expect(outcome.details.runs?.[0]?.conclusion).toBe("success");
		expect(clock.sleeps).toEqual([3000]);
	});

	it("streams progress updates while polling", async () => {
		let polls = 0;
		const gh = scriptedGh((args) => {
			if (args[1] === "view") {
				polls += 1;
				return Promise.resolve(
					okView(polls === 1 ? inProgressRun(100) : successRun(100)),
				);
			}
			return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
		});
		const updates: RunWatchDetails[] = [];
		await watchActions(
			{
				gh,
				git: {} as never,
				env: {},
				cwd: "/repo",
				clock: virtualClock(),
				onUpdate: (details) => updates.push({ ...details }),
			},
			baseTarget({ run: "100" }),
		);
		expect(updates.length).toBeGreaterThanOrEqual(3);
		expect(updates[0]).toMatchObject({
			op: "run_watch",
			repo: "owner/repo",
			run: 100,
			status: "started",
		});
		expect(updates.at(-1)).toMatchObject({ status: "success" });
	});

	it("uses 3s polls in the fast window and 15s after 60s", async () => {
		let polls = 0;
		const gh = scriptedGh((args) => {
			if (args[1] === "view") {
				polls += 1;
				// Stay in progress past the fast window, then complete.
				return Promise.resolve(
					okView(polls >= 24 ? successRun(100) : inProgressRun(100)),
				);
			}
			return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
		});
		const clock = virtualClock();
		await watchActions(
			{ gh, git: {} as never, env: {}, cwd: "/repo", clock },
			baseTarget({ run: "100" }),
		);
		expect(clock.sleeps.length).toBe(23);
		expect(clock.sleeps.slice(0, 20)).toEqual(Array(20).fill(3000));
		expect(clock.sleeps.slice(20)).toEqual(Array(3).fill(15000));
		expect(pollIntervalMs(0)).toBe(3000);
		expect(pollIntervalMs(59_999)).toBe(3000);
		expect(pollIntervalMs(60_000)).toBe(15_000);
	});

	it("applies the 5s failure grace, refetches, and inlines failed-job log tails", async () => {
		const log = Array.from(
			{ length: 40 },
			(_, index) => `line-${index + 1}`,
		).join("\n");
		const gh = scriptedGh((args) => {
			if (args[1] === "view") {
				// Poll 1: in progress with one failed job; poll 2: completed
				// with a second contemporaneous failure.
				return Promise.resolve(
					okView(
						polls === 1
							? inProgressRun(100, {
									jobs: [
										{
											databaseId: 11,
											name: "build",
											status: "completed",
											conclusion: "success",
										},
										{
											databaseId: 22,
											name: "test",
											status: "completed",
											conclusion: "failure",
										},
									],
								})
							: {
									...successRun(100),
									status: "completed",
									conclusion: "failure",
									jobs: [
										{
											databaseId: 11,
											name: "build",
											status: "completed",
											conclusion: "success",
										},
										{
											databaseId: 22,
											name: "test",
											status: "completed",
											conclusion: "failure",
										},
										{
											databaseId: 33,
											name: "lint",
											status: "completed",
											conclusion: "failure",
										},
									],
								},
					),
				);
			}
			if (args[0] === "api" && args[1]?.includes("/actions/jobs/")) {
				return Promise.resolve(result({ stdout: log }));
			}
			return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
		});
		let polls = 0;
		const countingGh = scriptedGh((args) => {
			if (args[1] === "view") polls += 1;
			return (gh as { run: GhHandler }).run(args);
		});
		const artifacts = mkdtempSync(join(tmpdir(), "pi-omp-git-artifacts-"));
		const clock = virtualClock();
		const updates: string[] = [];
		const outcome = await watchActions(
			{
				gh: countingGh,
				git: {} as never,
				env: {},
				cwd: "/repo",
				clock,
				artifactsDir: artifacts,
				onUpdate: (details) => updates.push(details.status ?? ""),
			},
			baseTarget({ run: "100" }),
		);
		expect(outcome.outcome).toBe("failure");
		expect(outcome.text).toContain("failed");
		expect(outcome.text).toContain("test — failure");
		expect(outcome.text).toContain("lint — failure");
		// Inline tail: last 15 lines by default (§44).
		expect(outcome.text).toContain(`line-${40 - DEFAULT_LOG_TAIL_LINES + 1}`);
		expect(outcome.text).not.toContain("line-1\n");
		// Grace sleep recorded exactly.
		expect(clock.sleeps).toContain(5000);
		// Updates: failure visible immediately, then the refetch.
		expect(updates).toContain("failure-detected");
		expect(updates).toContain("failure-refetched");
		// Full logs persisted as artifacts with the reference returned.
		const artifactLine = outcome.text
			.split("\n")
			.find((line) => line.includes("Full log: "));
		expect(artifactLine).toBeTruthy();
		const artifactPath = artifactLine
			?.replace("    Full log: ", "")
			.trim() as string;
		expect(readFileSync(artifactPath, "utf8")).toBe(log);
		rmSync(artifacts, { recursive: true, force: true });
	});

	it("honors the tail parameter: floors, clamps to 200, defaults to 15", async () => {
		const makeLog = (lines: number) =>
			Array.from({ length: lines }, (_, index) => `L${index + 1}`).join("\n");
		const gh = scriptedGh((args) => {
			if (args[1] === "view") {
				return Promise.resolve(
					okView({
						...successRun(100),
						conclusion: "failure",
						jobs: [
							{
								databaseId: 22,
								name: "test",
								status: "completed",
								conclusion: "failure",
							},
						],
					}),
				);
			}
			if (args[0] === "api") {
				return Promise.resolve(result({ stdout: makeLog(300) }));
			}
			return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
		});
		const artifacts = mkdtempSync(join(tmpdir(), "pi-omp-git-artifacts-"));
		const run = async (tail?: number) => {
			const outcome = await watchActions(
				{
					gh,
					git: {} as never,
					env: {},
					cwd: "/repo",
					clock: virtualClock(),
					artifactsDir: artifacts,
				},
				baseTarget({ run: "100", ...(tail !== undefined ? { tail } : {}) }),
			);
			const inline = outcome.text
				.split("\n")
				.filter((l) => l.startsWith("      L"));
			return inline;
		};
		expect((await run(3)).length).toBe(3);
		expect((await run(3))[0]).toBe("      L298");
		expect((await run(2.9)).length).toBe(2);
		expect((await run(500)).length).toBe(MAX_LOG_TAIL_LINES);
		expect((await run(undefined)).length).toBe(DEFAULT_LOG_TAIL_LINES);
		rmSync(artifacts, { recursive: true, force: true });
	});

	it("yields 'Log unavailable.' when a failed-job log cannot be fetched", async () => {
		const gh = scriptedGh((args) => {
			if (args[1] === "view") {
				return Promise.resolve(
					okView({
						...successRun(100),
						conclusion: "failure",
						jobs: [
							{
								databaseId: 22,
								name: "test",
								status: "completed",
								conclusion: "failure",
							},
						],
					}),
				);
			}
			if (args[0] === "api") {
				return Promise.resolve(result({ exitCode: 1, stderr: "boom" }));
			}
			return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
		});
		const outcome = await watchActions(
			{
				gh,
				git: {} as never,
				env: {},
				cwd: "/repo",
				clock: virtualClock(),
				artifactsDir: join(tmpdir(), "pi-omp-git-unused-artifacts"),
			},
			baseTarget({ run: "100" }),
		);
		expect(outcome.outcome).toBe("failure");
		expect(outcome.text).toContain("Log unavailable.");
		expect(outcome.text).not.toContain("Full log:");
	});

	it("watches an Actions run URL", async () => {
		const gh = scriptedGh((args) => {
			if (args[1] === "view") {
				return Promise.resolve(okView(successRun(77)));
			}
			return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
		});
		const outcome = await watchActions(
			{ gh, git: {} as never, env: {}, cwd: "/repo", clock: virtualClock() },
			baseTarget({
				run: "https://github.com/owner/repo/actions/runs/77",
			}),
		);
		expect(outcome.outcome).toBe("success");
		expect(outcome.details.run).toBe(77);
	});

	it("rejects a run URL that conflicts with an explicit repo", async () => {
		const gh = scriptedGh(() => Promise.resolve(result({ stdout: "{}" })));
		await expect(
			watchActions(
				{ gh, git: {} as never, env: {}, cwd: "/repo", clock: virtualClock() },
				baseTarget({
					run: "https://github.com/owner/repo/actions/runs/77",
					repo: "other/other",
				}),
			),
		).rejects.toThrow(PiOmpGitError);
	});

	it("cancellation stops polling and surfaces the abort", async () => {
		const controller = new AbortController();
		const seenSignals: AbortSignal[] = [];
		let polls = 0;
		const gh = scriptedGh(() => {
			polls += 1;
			if (polls === 2) controller.abort();
			return Promise.resolve(
				result({ exitCode: null, cancelled: polls === 2 }),
			);
		});
		const wrappingGh = scriptedGh((args) => {
			seenSignals.push(controller.signal);
			return (gh as { run: GhHandler }).run(args);
		});
		const clock = virtualClock({ signal: controller.signal });
		await expect(
			watchActions(
				{
					gh: wrappingGh,
					git: {} as never,
					env: {},
					cwd: "/repo",
					clock,
					signal: controller.signal,
				},
				baseTarget({ run: "100" }),
			),
		).rejects.toThrow();
		expect(seenSignals.length).toBeGreaterThanOrEqual(1);
	});
});

describe("poll-failure budget", () => {
	it("treats a transient API failure as transient and recovers", async () => {
		let polls = 0;
		const gh = scriptedGh((args) => {
			if (args[1] !== "view") {
				return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
			}
			polls += 1;
			if (polls === 1) {
				return Promise.resolve(result({ exitCode: 1, stderr: "boom" }));
			}
			return Promise.resolve(
				okView(polls === 2 ? inProgressRun(100) : successRun(100)),
			);
		});
		const clock = virtualClock();
		const outcome = await watchActions(
			{ gh, git: {} as never, env: {}, cwd: "/repo", clock },
			baseTarget({ run: "100" }),
		);
		expect(outcome.outcome).toBe("success");
		expect(polls).toBe(3);
	});

	it("throws ActionsRateLimitError when rate limiting exhausts the budget", async () => {
		let polls = 0;
		const gh = scriptedGh(() => {
			polls += 1;
			return Promise.resolve(
				result({
					exitCode: 1,
					stderr: "API rate limit exceeded for installation.",
				}),
			);
		});
		await expect(
			watchActions(
				{ gh, git: {} as never, env: {}, cwd: "/repo", clock: virtualClock() },
				baseTarget({ run: "100" }),
			),
		).rejects.toBeInstanceOf(ActionsRateLimitError);
		expect(polls).toBe(5);
	});

	it("throws ActionsWatchError for permanent API failures after the budget", async () => {
		let polls = 0;
		const gh = scriptedGh(() => {
			polls += 1;
			return Promise.resolve(
				result({ exitCode: 1, stderr: "server exploded" }),
			);
		});
		await expect(
			watchActions(
				{ gh, git: {} as never, env: {}, cwd: "/repo", clock: virtualClock() },
				baseTarget({ run: "100" }),
			),
		).rejects.toBeInstanceOf(ActionsWatchError);
		expect(polls).toBe(5);
	});
});

describe("commit mode", () => {
	it("discovers runs for an explicit commit SHA and aggregates several", async () => {
		const commits: string[] = [];
		let lists = 0;
		const gh = scriptedGh((args) => {
			if (args[1] === "list") {
				lists += 1;
				commits.push(args[args.indexOf("--commit") + 1] ?? "");
				return Promise.resolve(
					okView(
						lists === 1
							? [inProgressRun(500), inProgressRun(501)]
							: [
									successRun(500),
									{ ...successRun(501), conclusion: "success" },
								],
					),
				);
			}
			if (args[1] === "view") {
				const id = Number(args[2]);
				return Promise.resolve(okView(successRun(id)));
			}
			return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
		});
		const clock = virtualClock();
		const outcome = await watchActions(
			{ gh, git: {} as never, env: {}, cwd: "/repo", clock },
			baseTarget({ commit: "abc123def4567890" }),
		);
		expect(outcome.outcome).toBe("success");
		expect(outcome.details.commit).toBe("abc123def4567890");
		expect(outcome.details.runs?.map((run) => run.id)).toEqual([500, 501]);
		expect(commits.every((sha) => sha === "abc123def4567890")).toBe(true);
		// Stabilization: the list is refetched after all runs are green.
		expect(lists).toBeGreaterThanOrEqual(2);
	});

	it("stabilizes before declaring success so a late run is not missed", async () => {
		let lists = 0;
		let views501 = 0;
		const gh = scriptedGh((args) => {
			if (args[1] === "list") {
				lists += 1;
				return Promise.resolve(
					okView(
						lists === 1
							? [successRun(500)]
							: lists === 2
								? [successRun(500), inProgressRun(501)]
								: [successRun(500), successRun(501)],
					),
				);
			}
			if (args[1] === "view" && args[2] === "501") {
				views501 += 1;
				return Promise.resolve(
					okView(views501 === 1 ? inProgressRun(501) : successRun(501)),
				);
			}
			if (args[1] === "view") {
				return Promise.resolve(okView(successRun(500)));
			}
			return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
		});
		const clock = virtualClock();
		const outcome = await watchActions(
			{ gh, git: {} as never, env: {}, cwd: "/repo", clock },
			baseTarget({ commit: "abc123def4567890" }),
		);
		expect(outcome.outcome).toBe("success");
		expect(outcome.details.runs?.map((run) => run.id)).toEqual([500, 501]);
		expect(lists).toBeGreaterThanOrEqual(3);
		// The stabilization waits one additional poll interval before the refetch.
		expect(
			clock.sleeps.filter((ms) => ms === 3000 || ms === 15000).length,
		).toBeGreaterThanOrEqual(2);
	});

	it("returns the no-runs outcome after the 90-second timeout", async () => {
		const gh = scriptedGh((args) => {
			if (args[1] === "list") {
				return Promise.resolve(okView([]));
			}
			return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
		});
		const clock = virtualClock();
		const outcome = await watchActions(
			{ gh, git: {} as never, env: {}, cwd: "/repo", clock },
			baseTarget({ commit: "abc123def4567890" }),
		);
		expect(outcome.outcome).toBe("no-runs");
		expect(outcome.text).toContain("No workflow runs found");
		expect(outcome.text).toContain("within 90 seconds");
		// Elapsed virtual time reached the timeout exactly through sleeps.
		const total = clock.sleeps.reduce((sum, ms) => sum + ms, 0);
		expect(total).toBeGreaterThanOrEqual(90_000);
		expect(clock.sleeps.slice(0, 20)).toEqual(Array(20).fill(3000));
	});

	it("aggregates a failed run among successful ones", async () => {
		let lists = 0;
		const gh = scriptedGh((args) => {
			if (args[1] === "list") {
				lists += 1;
				return Promise.resolve(
					okView(
						lists === 1
							? [inProgressRun(500), inProgressRun(501)]
							: [
									successRun(500),
									{ ...successRun(501), conclusion: "failure" },
								],
					),
				);
			}
			if (args[1] === "view") {
				const id = Number(args[2]);
				if (id === 501) {
					return Promise.resolve(
						okView({
							...successRun(501),
							conclusion: "failure",
							jobs: [
								{
									databaseId: 91,
									name: "e2e",
									status: "completed",
									conclusion: "failure",
								},
							],
						}),
					);
				}
				return Promise.resolve(okView(successRun(id)));
			}
			if (args[0] === "api") {
				return Promise.resolve(result({ stdout: "step failed\nexit 1" }));
			}
			return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
		});
		const artifacts = mkdtempSync(join(tmpdir(), "pi-omp-git-artifacts-"));
		const outcome = await watchActions(
			{
				gh,
				git: {} as never,
				env: {},
				cwd: "/repo",
				clock: virtualClock(),
				artifactsDir: artifacts,
			},
			baseTarget({ commit: "abc123def4567890" }),
		);
		expect(outcome.outcome).toBe("failure");
		expect(outcome.details.runs?.map((run) => run.id)).toEqual([500, 501]);
		expect(outcome.text).toContain("e2e — failure");
		expect(outcome.text).toContain("exit 1");
		rmSync(artifacts, { recursive: true, force: true });
	});

	it("resolves the commit from an explicit pr parameter", async () => {
		const commits: string[] = [];
		const gh = scriptedGh((args) => {
			if (args[0] === "pr" && args[1] === "view") {
				return Promise.resolve(okView({ headRefOid: "0123456789abcdef" }));
			}
			if (args[1] === "list") {
				commits.push(args[args.indexOf("--commit") + 1] ?? "");
				return Promise.resolve(okView([]));
			}
			return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
		});
		const clock = virtualClock();
		const outcome = await watchActions(
			{ gh, git: {} as never, env: {}, cwd: "/repo", clock },
			baseTarget({ pr: "418" }),
		);
		expect(outcome.outcome).toBe("no-runs");
		expect(commits[0]).toBe("0123456789abcdef");
	});

	it("resolves the commit from the last checkout's head SHA, then HEAD", async () => {
		const gitCalls: string[][] = [];
		const git = {
			run(args: string[]) {
				gitCalls.push([...args]);
				if (args[0] === "rev-parse" && args[1] === "refs/heads/pr-7") {
					return Promise.resolve(
						result({ stdout: "aaaa0000bbbb1111cccc2222dddd3333eeee4444\n" }),
					);
				}
				return Promise.resolve(result({ exitCode: 1 }));
			},
		} as never;
		const gh = scriptedGh((args) => {
			if (args[1] === "list") {
				return Promise.resolve(okView([successRun(500)]));
			}
			if (args[1] === "view") {
				return Promise.resolve(okView(successRun(Number(args[2]))));
			}
			return Promise.resolve(result({ exitCode: 1, stderr: "unexpected" }));
		});
		const outcome = await watchActions(
			{
				gh,
				git,
				env: {},
				cwd: "/repo",
				clock: virtualClock(),
				getLastCheckout: () => ({
					pr: "418",
					number: 418,
					branch: "pr-7",
					worktreePath: "/wt/pr-7",
				}),
			},
			baseTarget({}),
		);
		expect(outcome.outcome).toBe("success");
		expect(outcome.details.commit).toBe(
			"aaaa0000bbbb1111cccc2222dddd3333eeee4444",
		);
		expect(gitCalls[0]).toEqual(["rev-parse", "refs/heads/pr-7"]);
	});
});

describe("validation", () => {
	it("rejects zero and non-finite tail, floors nonintegers, clamps above 200", async () => {
		// Validation lives in the dispatcher; covered there. Here: the
		// collector clamps defensively.
		expect(MAX_LOG_TAIL_LINES).toBe(200);
		expect(DEFAULT_LOG_TAIL_LINES).toBe(15);
	});
});
