/**
 * The centralized process runner — every `gh` and `git` subprocess in the
 * package flows through here (docs/pi-omp-git-reference.md §46–§48).
 *
 * Contract:
 * - argument arrays only; `shell` is never used, so nothing is ever
 *   interpolated by a shell;
 * - noninteractive environment (prompts and askpass disabled) without
 *   clobbering user-supplied authentication variables;
 * - a stabilized locale on request for outputs that are parsed;
 * - 5-minute timeout and 8 MiB output cap with honest truncation reporting;
 * - cancellation terminates the underlying child process.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { GH_OUTPUT_CAP_BYTES, GH_TIMEOUT_MS } from "./limits.ts";

export interface RunResult {
	/** Exit code; null when the child died by signal (timeout/cancel/cap). */
	exitCode: number | null;
	termSignal?: string;
	stdout: string;
	stderr: string;
	/** Output was cut at the cap; bytes past the cap were discarded. */
	truncated: boolean;
	timedOut: boolean;
	cancelled: boolean;
}

export interface ExecSpec {
	command: string;
	args: string[];
	cwd?: string;
	env: Record<string, string>;
	timeoutMs: number;
	outputCapBytes: number;
	signal?: AbortSignal;
}

export type Exec = (spec: ExecSpec) => Promise<RunResult>;

/** The binary was absent from PATH (mapped to the friendly dependency error). */
export class CommandNotFoundError extends Error {
	readonly code = "ENOENT";

	constructor(public readonly command: string) {
		super(`command not found: ${command}`);
		this.name = "CommandNotFoundError";
	}
}

const NONINTERACTIVE_ENV: Readonly<Record<string, string>> = {
	GH_PROMPT_DISABLED: "1",
	GIT_TERMINAL_PROMPT: "0",
	GIT_EDITOR: "true",
	GIT_ASKPASS: "true",
	SSH_ASKPASS_REQUIRE: "never",
};

const STABLE_LOCALE_ENV: Readonly<Record<string, string>> = {
	LC_ALL: "C",
	LANG: "C",
};

export interface RunnerOptions {
	/** Injection seam: scripted-fixture executors replace the real spawner. */
	exec?: Exec;
	/** Default cwd for every run. */
	cwd?: string;
	timeoutMs?: number;
	outputCapBytes?: number;
}

export interface RunOptions {
	args: string[];
	cwd?: string;
	/** `stable` forces a C locale for outputs that are parsed. */
	locale?: "stable" | "inherit";
	/** Caller-supplied environment additions; auth variables flow through. */
	extraEnv?: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs?: number;
	outputCapBytes?: number;
}

export interface Runner {
	run(command: string, options: RunOptions): Promise<RunResult>;
}

const KILL_GRACE_MS = 500;

export function createRunner(options: RunnerOptions = {}): Runner {
	const exec = options.exec ?? spawnExec;
	const defaultTimeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;
	const defaultOutputCapBytes = options.outputCapBytes ?? GH_OUTPUT_CAP_BYTES;

	return {
		run(command, runOptions) {
			const { signal } = runOptions;
			if (signal?.aborted) {
				return Promise.resolve(cancelledRun());
			}
			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined) env[key] = value;
			}
			// Forced, deliberate noninteractive settings — never authentication
			// variables; those come only from the user's own environment or the
			// caller's extraEnv, which land last and are never ours to set.
			Object.assign(env, NONINTERACTIVE_ENV);
			if ((runOptions.locale ?? "inherit") === "stable") {
				Object.assign(env, STABLE_LOCALE_ENV);
			}
			if (runOptions.extraEnv) {
				Object.assign(env, runOptions.extraEnv);
			}
			return exec({
				command,
				args: [...runOptions.args],
				cwd: runOptions.cwd ?? options.cwd,
				env,
				timeoutMs: runOptions.timeoutMs ?? defaultTimeoutMs,
				outputCapBytes: runOptions.outputCapBytes ?? defaultOutputCapBytes,
				signal,
			});
		},
	};
}

function cancelledRun(): RunResult {
	return {
		exitCode: null,
		stdout: "",
		stderr: "",
		truncated: false,
		timedOut: false,
		cancelled: true,
	};
}

function killChild(child: ReturnType<typeof spawn>): void {
	try {
		child.kill("SIGTERM");
	} catch {
		// already gone
	}
	const hard = setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			// ignore — the child is dead
		}
	}, KILL_GRACE_MS);
	hard.unref();
}

/**
 * The real executor: spawn with an argument array, `shell: false`, stdin
 * closed. Enforces the timeout and output cap; resolves with the outcome,
 * throwing only when the command cannot be spawned at all.
 */
export const spawnExec: Exec = (spec) =>
	new Promise((resolve, reject) => {
		let settled = false;
		let timedOut = false;
		let cancelled = false;
		let truncated = false;
		let totalBytes = 0;
		let stdout = "";
		let stderr = "";
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");

		const child = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			env: spec.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			killChild(child);
		}, spec.timeoutMs);

		const onAbort = () => {
			cancelled = true;
			killChild(child);
		};
		spec.signal?.addEventListener("abort", onAbort, { once: true });

		const track =
			(sink: (decoded: string) => void, decoder: StringDecoder) =>
			(chunk: Buffer) => {
				if (totalBytes >= spec.outputCapBytes) {
					// Bytes past the cap are discarded; enforce the cap by cutting the
					// child off rather than letting it stream into the void.
					if (
						!timedOut &&
						!cancelled &&
						child.exitCode === null &&
						child.signalCode === null
					) {
						killChild(child);
					}
					return;
				}
				const room = spec.outputCapBytes - totalBytes;
				if (chunk.byteLength > room) {
					truncated = true;
					totalBytes = spec.outputCapBytes;
					sink(decoder.write(chunk.subarray(0, room)));
					killChild(child);
					return;
				}
				totalBytes += chunk.byteLength;
				sink(decoder.write(chunk));
			};

		child.stdout?.on(
			"data",
			track((decoded) => {
				stdout += decoded;
			}, stdoutDecoder),
		);
		child.stderr?.on(
			"data",
			track((decoded) => {
				stderr += decoded;
			}, stderrDecoder),
		);

		const settle = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			spec.signal?.removeEventListener("abort", onAbort);
			fn();
		};

		child.on("close", (code, signalName) => {
			settle(() =>
				resolve({
					exitCode: signalName ? null : (code ?? null),
					termSignal: signalName ?? undefined,
					stdout: stdout + stdoutDecoder.end(),
					stderr: stderr + stderrDecoder.end(),
					truncated,
					timedOut,
					cancelled,
				}),
			);
		});

		child.on("error", (error: NodeJS.ErrnoException) => {
			settle(() => {
				if (error.code === "ENOENT") {
					reject(new CommandNotFoundError(spec.command));
					return;
				}
				reject(error);
			});
		});
	});
