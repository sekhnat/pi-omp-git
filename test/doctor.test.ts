import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctorCommand } from "../src/cli.ts";
import { CONFIG_FILE_NAME } from "../src/shared/config.ts";
import {
	type CollectDoctorOptions,
	collectDoctorReport,
	DOCTOR_OUTPUT_CAP_BYTES,
	DOCTOR_TIMEOUT_MS,
	formatDoctorReport,
} from "../src/shared/doctor.ts";
import {
	CommandNotFoundError,
	type Runner,
	type RunResult,
} from "../src/shared/subprocess.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) {
		rmSync(path, { force: true, recursive: true });
	}
});

function runResult(
	exitCode: number | null,
	stdout = "",
	stderr = "",
): RunResult {
	return {
		exitCode,
		stdout,
		stderr,
		truncated: false,
		timedOut: false,
		cancelled: false,
	};
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-omp-git-doctor-"));
	temporaryDirectories.push(root);
	const agentDir = join(root, "custom-agent");
	const cwd = join(root, "repo");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const calls: Array<{
		command: string;
		args: string[];
		timeoutMs?: number;
		outputCapBytes?: number;
		extraEnv?: Record<string, string>;
	}> = [];
	const routes = new Map<string, RunResult | Error>();
	const runner: Runner = {
		async run(command, options) {
			calls.push({
				command,
				args: [...options.args],
				timeoutMs: options.timeoutMs,
				outputCapBytes: options.outputCapBytes,
				extraEnv: options.extraEnv,
			});
			const key = `${command} ${options.args.join(" ")}`;
			const scripted = routes.get(key);
			if (scripted instanceof Error) throw scripted;
			if (scripted) return scripted;
			if (key === "git --version") return runResult(0, "git version 2.45.1\n");
			if (key === "git rev-parse --show-toplevel")
				return runResult(0, `${cwd}\n`);
			if (key === "gh --version")
				return runResult(0, "gh version 2.68.0 (fixture)\n");
			if (key === "gh auth status") return runResult(0, "Logged in\n");
			return runResult(1);
		},
	};
	const options: CollectDoctorOptions = {
		agentDir,
		cwd,
		env: {} as NodeJS.ProcessEnv,
		projectTrusted: false,
		runner,
		packageVersion: "0.1.0",
	};
	return { root, agentDir, cwd, calls, routes, options };
}

function writeUserConfig(agentDir: string, value: unknown): void {
	writeFileSync(join(agentDir, CONFIG_FILE_NAME), JSON.stringify(value));
}

describe("doctor diagnostics", () => {
	it("does not invoke gh when GitHub integration is disabled", async () => {
		const test = fixture();
		writeUserConfig(test.agentDir, { github: { enabled: false } });

		const report = await collectDoctorReport(test.options);
		const text = formatDoctorReport(report);

		expect(report.github.enabled).toBe(false);
		expect(report.github.cli.status).toBe("disabled");
		expect(report.github.auth.status).toBe("disabled");
		expect(test.calls.some((call) => call.command === "gh")).toBe(false);
		expect(text).toContain("GitHub integration: disabled");
	});

	it("classifies missing gh as optional while reporting Git", async () => {
		const test = fixture();
		test.routes.set("gh --version", new CommandNotFoundError("gh"));

		const report = await collectDoctorReport(test.options);

		expect(report.git.status).toBe("ok");
		expect(report.git.value).toBe("2.45.1");
		expect(report.github.cli.status).toBe("optional-unavailable");
		expect(report.github.auth.status).toBe("optional-unavailable");
		expect(test.calls.map((call) => call.args.join(" "))).not.toContain(
			"auth status",
		);
	});

	it("uses the custom agent directory and reports discovered versus active config", async () => {
		const test = fixture();
		const customWorktrees = join(test.root, "managed-worktrees");
		writeUserConfig(test.agentDir, { worktree: { root: customWorktrees } });
		const projectConfig = join(test.cwd, ".pi");
		mkdirSync(projectConfig);
		writeFileSync(
			join(projectConfig, CONFIG_FILE_NAME),
			JSON.stringify({
				worktree: { root: join(test.root, "untrusted-worktrees") },
			}),
		);
		test.options.piVersion = "0.87.1";

		const report = await collectDoctorReport(test.options);
		const project = report.configuration.sources.find(
			(source) => source.layer === "project",
		);

		expect(report.paths.agentDirectory.path).toBe(test.agentDir);
		expect(report.paths.worktreeRoot.path).toBe(customWorktrees);
		expect(report.versions.pi).toBe("0.87.1");
		expect(report.configuration.activeLayers).toContain("user");
		expect(project).toMatchObject({ discovered: true, active: false });
	});

	it("reports an unwritable cache directory as an actionable error", async () => {
		const test = fixture();
		const cacheDatabase = join(test.root, "cache", "github-cache.db");
		test.options.env.PI_OMP_GITHUB_CACHE_DB = cacheDatabase;
		test.options.inspectDirectory = async (path) => ({
			exists: true,
			writable: path !== dirname(cacheDatabase),
		});

		const report = await collectDoctorReport(test.options);
		const text = formatDoctorReport(report);

		expect(report.paths.cacheDatabase).toBe(cacheDatabase);
		expect(report.paths.cacheDirectory.access.status).toBe("error");
		expect(text).toContain("Directory is not writable");
	});

	it("renders the shared disabled diagnostics from the CLI without a Pi session", async () => {
		const test = fixture();
		writeUserConfig(test.agentDir, { github: { enabled: false } });
		let output = "";
		const exitCode = await runDoctorCommand(test.options, (text) => {
			output = text;
		});

		expect(exitCode).toBe(0);
		expect(output).toContain("GitHub integration: disabled");
		expect(output).toContain(
			"GitHub auth: GitHub integration is disabled by configuration.",
		);
		expect(test.calls.some((call) => call.command === "gh")).toBe(false);
	});

	it("never includes credential values or raw gh output and bounds every probe", async () => {
		const test = fixture();
		const token = "ghp_do_not_print_this_token";
		test.options.env.GH_TOKEN = token;
		test.routes.set(
			"gh auth status",
			runResult(0, `authenticated ${token}`, `warning ${token}`),
		);

		const report = await collectDoctorReport(test.options);
		const text = formatDoctorReport(report);

		expect(report.github.auth.status).toBe("ok");
		expect(JSON.stringify(report)).not.toContain(token);
		expect(text).not.toContain(token);
		expect(text).not.toContain("warning");
		expect(test.calls.length).toBeGreaterThan(0);
		for (const call of test.calls) {
			expect(call.timeoutMs).toBe(DOCTOR_TIMEOUT_MS);
			expect(call.outputCapBytes).toBe(DOCTOR_OUTPUT_CAP_BYTES);
		}
	});
});
