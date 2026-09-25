/**
 * Ticket 24 acceptance tests: the companion binary. Deep scenarios are
 * covered by the library-level pipeline/TUI tests (one pipeline, two
 * hosts — ADR 0004); these tests exercise the binary surface itself:
 * argument parsing, the TTY guard, help/usage, and the deterministic
 * end-to-end paths that need no model (clean-tree commit, --help).
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs, USAGE } from "../src/cli.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

const BIN = join(import.meta.dirname, "..", "bin", "pi-omp-git.mjs");

function run(
	args: string[],
	options: { cwd?: string; env?: Record<string, string> } = {},
): { status: number; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [BIN, ...args], {
		cwd: options.cwd,
		encoding: "utf8",
		env: {
			...process.env,
			...(options.env ?? {}),
		},
	});
	return {
		status: result.status ?? -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function initRepo(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-omp-git-bin-"));
	tempDirs.push(path);
	execFileSync("git", ["init", "-q", "--initial-branch=main", "."], {
		cwd: path,
		env: { ...process.env },
	});
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: path });
	execFileSync("git", ["config", "user.name", "t"], { cwd: path });
	writeFileSync(join(path, "base.txt"), "1\n2\n3\n");
	execFileSync("git", ["add", "-A", "."], { cwd: path });
	execFileSync("git", ["commit", "-q", "-m", "feat: init"], { cwd: path });
	return path;
}

describe("argument parsing", () => {
	it("parses -C, the revision, and commit flags", () => {
		const parsed = parseCliArgs([
			"-C",
			"/tmp/repo",
			"--dry-run",
			"--push",
			"--no-changelog",
			"--context",
			"release notes",
			"--model",
			"gpt-5",
		]);
		expect(parsed.dir).toBe("/tmp/repo");
		expect(parsed.dryRun).toBe(true);
		expect(parsed.push).toBe(true);
		expect(parsed.noChangelog).toBe(true);
		expect(parsed.context).toBe("release notes");
		expect(parsed.model).toBe("gpt-5");
	});

	it("parses the positional revision", () => {
		expect(parseCliArgs(["HEAD~1"]).revision).toBe("HEAD~1");
	});

	it("rejects unknown options and missing values", () => {
		expect(() => parseCliArgs(["--wat"])).toThrow(/Unknown option/);
		expect(() => parseCliArgs(["-C"])).toThrow(/-C requires/);
		expect(() => parseCliArgs(["--model"])).toThrow(/--model requires/);
		expect(() => parseCliArgs(["a", "b"])).toThrow(/Unexpected arguments/);
	});
});

describe("binary surface", () => {
	it("prints usage for --help and unknown commands", () => {
		const help = run(["--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("pi-omp-git git");
		expect(help.stdout).toContain("pi-omp-git commit");
		expect(USAGE).toContain("--dry-run");

		const unknown = run(["frobnicate"]);
		expect(unknown.status).toBe(1);
		expect(unknown.stderr).toContain("Unknown command: frobnicate");
	});

	it("requires a TTY for the git UI", () => {
		const repo = initRepo();
		const result = run(["git"], { cwd: repo });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("requires an interactive TTY");

		const revision = run(["git", "HEAD"], { cwd: repo });
		expect(revision.status).toBe(1);
		expect(revision.stderr).toContain("requires an interactive TTY");
	});

	it("reports unknown revisions before opening the UI", () => {
		const repo = initRepo();
		const result = run(["git", "no-such-ref"], { cwd: repo });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Unknown revision: no-such-ref");
	});

	it("blocks push when GitHub is disabled while preserving Git-only commits", () => {
		const repo = initRepo();
		const agentDir = mkdtempSync(join(tmpdir(), "pi-omp-git-cli-agent-"));
		tempDirs.push(agentDir);
		writeFileSync(
			join(agentDir, "pi-omp-git.json"),
			JSON.stringify({ github: { enabled: false } }),
		);
		const fakeBin = join(agentDir, "bin");
		mkdirSync(fakeBin);
		const ghLog = join(agentDir, "gh-called");
		const fakeGh = join(fakeBin, "gh");
		writeFileSync(fakeGh, `#!/bin/sh\nprintf called >> "${ghLog}"\n`);
		chmodSync(fakeGh, 0o755);
		const env = {
			PI_CODING_AGENT_DIR: agentDir,
			PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
		};

		const push = run(["commit", "-C", repo, "--push"], { env });
		expect(push.status).toBe(1);
		expect(push.stderr).toContain("GitHub integration is disabled");
		expect(existsSync(ghLog)).toBe(false);

		const localCommit = run(["commit", "-C", repo], { env });
		expect(localCommit.status).toBe(0);
		expect(localCommit.stdout).toContain("Nothing to commit");
		expect(existsSync(ghLog)).toBe(false);
	});

	it("returns a definitive no-changes outcome for a clean tree without a model", async () => {
		const repo = initRepo();
		const result = run(["commit"], { cwd: repo });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Nothing to commit");
	}, 60_000);

	it("surfaces pipeline errors with a nonzero exit and no stack traces", async () => {
		// A staged change requires the commit agent; without a usable model
		// configuration the pipeline fails with its error message. (A dirty
		// tree with nothing staged is guidance, not an error.)
		const repo = initRepo();
		writeFileSync(join(repo, "a.txt"), "change\n");
		execFileSync("git", ["add", "a.txt"], { cwd: repo, stdio: "ignore" });
		const result = run(["commit", "--dry-run"], { cwd: repo });
		expect(result.status).toBe(1);
		expect(result.stderr).not.toMatch(/at \S+ \(/); // no stack frames
		expect(result.stderr.trim().length).toBeGreaterThan(0);
	}, 120_000);
});
