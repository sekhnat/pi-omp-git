/**
 * Dependency gating — ticket 01: missing/unauthenticated `gh` must degrade
 * gracefully; Git keeps working independently; probes are memoized.
 */

import { describe, expect, it } from "vitest";
import { createGitRunner } from "../src/git/runner.ts";
import { createAvailability } from "../src/github/availability.ts";
import { createScriptedExec } from "../src/github/runner.ts";
import type { Exec, ExecSpec, RunResult } from "../src/shared/subprocess.ts";
import {
	CommandNotFoundError,
	createRunner,
} from "../src/shared/subprocess.ts";

const ok = (stdout = ""): RunResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
	truncated: false,
	timedOut: false,
	cancelled: false,
});

const failingExec: Exec = async () => {
	throw new CommandNotFoundError("gh");
};

function execFor(
	fixtures: Record<
		string,
		{ stdout?: string; stderr?: string; exitCode?: number }
	>,
): Exec {
	return createScriptedExec(fixtures);
}

describe("gh availability gating", () => {
	it("reports missing gh with the stable friendly error", async () => {
		const runner = createRunner({ exec: failingExec });
		const availability = createAvailability(runner);
		const status = await availability.gh();
		expect(status.ok).toBe(false);
		if (!status.ok) {
			expect(status.reason).toBe("missing");
			expect(status.message).toBe("GitHub CLI (gh) is not installed.");
		}
	});

	it("reports unauthenticated gh with the login hint", async () => {
		const runner = createRunner({
			exec: execFor({
				"gh --version": { stdout: "gh version 2.40.0\n", exitCode: 0 },
				"gh auth status": { exitCode: 1, stderr: "not logged in" },
			}),
		});
		const availability = createAvailability(runner);
		const status = await availability.gh();
		expect(status.ok).toBe(false);
		if (!status.ok) {
			expect(status.reason).toBe("unauthenticated");
			expect(status.message).toContain("gh auth login");
		}
	});

	it("reports available when gh is present and authenticated", async () => {
		const runner = createRunner({
			exec: execFor({
				"gh --version": { stdout: "gh version 2.40.0\n", exitCode: 0 },
				"gh auth status": { exitCode: 0 },
			}),
		});
		const availability = createAvailability(runner);
		expect(await availability.gh()).toEqual({ ok: true });
	});

	it("treats a broken gh --version as missing", async () => {
		const runner = createRunner({
			exec: execFor({
				"gh --version": { stdout: "usage: gh\n", exitCode: 0 },
			}),
		});
		const availability = createAvailability(runner);
		const status = await availability.gh();
		if (!status.ok) expect(status.reason).toBe("missing");
		else expect.unreachable("expected missing");
	});

	it("memoizes probes until reset", async () => {
		const calls: ExecSpec[] = [];
		const exec: Exec = async (spec) => {
			calls.push(spec);
			return {
				exitCode: 0,
				stdout: "gh version 2.40.0\n",
				stderr: "",
				truncated: false,
				timedOut: false,
				cancelled: false,
			};
		};
		const runner = createRunner({ exec });
		const availability = createAvailability(runner);
		await availability.gh();
		await availability.gh();
		expect(calls).toHaveLength(2); // version + auth, once
		availability.reset();
		await availability.gh();
		expect(calls).toHaveLength(4);
	});
});

describe("git availability", () => {
	it("works independently of gh state", async () => {
		const availability = createAvailability(
			createRunner({
				exec: async (spec) => {
					if (spec.command === "git") {
						return ok("git version 2.47.0\n");
					}
					throw new CommandNotFoundError(spec.command);
				},
			}),
		);
		expect(await availability.git()).toEqual({ ok: true });
		const gh = await availability.gh();
		expect(gh.ok).toBe(false);
		if (!gh.ok) expect(gh.reason).toBe("missing");
	});

	it("reports missing git with its own friendly error", async () => {
		const availability = createAvailability(
			createRunner({ exec: failingExec }),
		);
		const status = await availability.git();
		expect(status.ok).toBe(false);
		if (!status.ok) expect(status.message).toBe("Git is not installed.");
	});

	it("routes git subprocesses through the same central runner", async () => {
		const git = createGitRunner({
			exec: execFor({
				"git status --porcelain": { stdout: "?? new.txt\n", exitCode: 0 },
			}),
		});
		const result = await git.run(["status", "--porcelain"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("?? new.txt\n");
	});
});
