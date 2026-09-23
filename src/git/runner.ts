/**
 * The `git` facade over the central runner. Git keeps working when `gh`
 * is missing or unauthenticated — the facade never gates on GitHub state.
 */

import {
	createRunner,
	type Exec,
	type Runner,
	type RunOptions,
	type RunResult,
} from "../shared/subprocess.ts";

export interface GitRunnerOptions {
	/** Injection seam (used by availability tests and later tickets). */
	exec?: Exec;
	/** Default cwd; resolved against the current checkout when omitted. */
	cwd?: string;
}

export interface GitRunner {
	run(args: string[], options?: Partial<RunOptions>): Promise<RunResult>;
}

export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
	const runner: Runner = createRunner({ exec: options.exec, cwd: options.cwd });
	return {
		run(args, runOptions = {}) {
			return runner.run("git", { ...runOptions, args: [...args] });
		},
	};
}
