/**
 * The scripted-fixture seam — the single injection point every later
 * ticket's GitHub tests use. Fixtures map recorded argv to stdout/exit.
 */

import { describe, expect, it } from "vitest";
import { createGitRunner } from "../src/git/runner.ts";
import { createGhRunner, createScriptedExec } from "../src/github/runner.ts";
import type { Exec, RunResult } from "../src/shared/subprocess.ts";
import { createRunner } from "../src/shared/subprocess.ts";

const fixtures: Record<
	string,
	{ stdout?: string; stderr?: string; exitCode?: number }
> = {
	"gh issue view 123": { stdout: "title: Bug\nstate: OPEN\n", exitCode: 0 },
	"gh pr list --limit 5": { stdout: "[]", exitCode: 0 },
	"gh auth status": { exitCode: 1, stderr: "gh: not logged in" },
};

describe("scripted fixture seam", () => {
	it("maps recorded argv to stdout and exit code", async () => {
		const exec = createScriptedExec(fixtures);
		const runner = createRunner({ exec });
		const result = await runner.run("gh", { args: ["issue", "view", "123"] });
		expect(result.stdout).toBe("title: Bug\nstate: OPEN\n");
		expect(result.exitCode).toBe(0);
		expect(result.truncated).toBe(false);
	});

	it("maps stderr and non-zero exits", async () => {
		const exec = createScriptedExec(fixtures);
		const runner = createRunner({ exec });
		const result = await runner.run("gh", { args: ["auth", "status"] });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("not logged in");
	});

	it("rejects unknown argv with the exact command line named", async () => {
		const recorded: string[] = [];
		const exec = createScriptedExec(fixtures, recorded);
		const runner = createRunner({ exec });
		await expect(runner.run("gh", { args: ["gist", "list"] })).rejects.toThrow(
			/gh gist/,
		);
		expect(recorded).toEqual(["gh gist list"]);
	});

	it("drives the gh runner facade later tickets inject at", async () => {
		const gh = createGhRunner({ exec: createScriptedExec(fixtures) });
		const result = await gh.run(["pr", "list", "--limit", "5"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("[]");
	});

	it("drives the git runner facade the same way", async () => {
		const git = createGitRunner({
			exec: createScriptedExec({
				"git status --porcelain": {
					stdout: " M a.txt\n",
					exitCode: 0,
				},
			}),
		});
		const result = await git.run(["status", "--porcelain"], {
			cwd: "/srv/repo",
		});
		expect(result.stdout).toBe(" M a.txt\n");
	});

	it("records the fully-stabilized environment it would have run under", async () => {
		const seen: Array<{ env: Record<string, string>; spec: RunResult | null }> =
			[];
		const exec: Exec = async (spec) => {
			seen.push({ env: spec.env, spec: null });
			return {
				exitCode: 0,
				stdout: "",
				stderr: "",
				truncated: false,
				timedOut: false,
				cancelled: false,
			};
		};
		const runner = createRunner({ exec });
		await runner.run("gh", {
			args: ["issue", "view", "1"],
			locale: "stable",
			extraEnv: { GH_HOST: "e" },
		});
		const env = seen[0]?.env;
		expect(env?.GH_PROMPT_DISABLED).toBe("1");
		expect(env?.LC_ALL).toBe("C");
		expect(env?.GH_HOST).toBe("e");
	});
});
