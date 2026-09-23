/**
 * The `gh` facade — every GitHub subprocess goes through the central
 * runner, and the scripted-fixture seam injects at this boundary.
 * (docs/pi-omp-git-reference.md §46, Testing Decisions seam 1)
 */

import {
	createRunner,
	type Exec,
	type Runner,
	type RunOptions,
	type RunResult,
} from "../shared/subprocess.ts";

export interface GhRunnerOptions {
	/** Scripted-fixture executor; omit for real `gh` spawns. */
	exec?: Exec;
	/** Default cwd for every gh run. */
	cwd?: string;
}

export interface GhRunner {
	/** `locale` defaults to `stable` — gh outputs are parsed. */
	run(args: string[], options?: Partial<RunOptions>): Promise<RunResult>;
}

export function createGhRunner(options: GhRunnerOptions = {}): GhRunner {
	const runner: Runner = createRunner({ exec: options.exec, cwd: options.cwd });
	return {
		run(args, runOptions = {}) {
			return runner.run("gh", {
				locale: "stable",
				...runOptions,
				args: [...args],
			});
		},
	};
}

/** A recorded fixture: argv key → stdout/stderr/exit code. */
export interface GhFixture {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
}

export type GhFixtureMap = Record<string, GhFixture>;

/** Canonical, human-readable key for recorded argv: `gh issue view 123`. */
export function argvKey(command: string, args: readonly string[]): string {
	return [command, ...args].join(" ");
}

/**
 * The scripted executor every later ticket's tests inject at the runner.
 * Fixtures map recorded argv to stdout/exit. Unknown argv is recorded and
 * rejected — it never falls back to a real process.
 */
export function createScriptedExec(
	fixtures: GhFixtureMap,
	recordMisses?: string[],
): Exec {
	return async (spec) => {
		const key = argvKey(spec.command, spec.args);
		const fixture = fixtures[key];
		if (!fixture) {
			recordMisses?.push(key);
			throw new Error(
				`No fixture recorded for argv: ${key}\n` +
					`Add to the fixture map: ${JSON.stringify({ [key]: { stdout: "<recorded stdout>", exitCode: 0 } }, null, 2)}`,
			);
		}
		return {
			exitCode: fixture.exitCode ?? 0,
			stdout: fixture.stdout ?? "",
			stderr: fixture.stderr ?? "",
			truncated: false,
			timedOut: false,
			cancelled: false,
		};
	};
}
