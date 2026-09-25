/**
 * The `pi-omp-git` companion binary (docs/pi-omp-git-reference.md §30
 * area, §60, §73; ticket 24).
 *
 * `pi-omp-git git [revision] [-C dir]` opens the same interactive Git
 * TUI as `/git` — the binary reuses the shared TUI component, so
 * rendering matches the in-Pi experience. It requires an interactive
 * TTY.
 *
 * `pi-omp-git commit [--all] [--push] [--dry-run] [--no-changelog]
 * [--context <text>] [--model <model>] [-C dir]` runs the same agentic
 * commit pipeline as the `/commit` command (ADR 0004: one pipeline
 * implementation, two hosts). Commits the staged set by default;
 * `--all` opts into staging the full change set.
 */

import {
	getAgentDir,
	ModelRegistry,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { type CommitArgs, parseCommitTokens } from "./git/commit-args.ts";
import { runCommitPipeline } from "./git/commit-pipeline.ts";
import { collectRevisionStatus, resolveRevision } from "./git/revision.ts";
import { createGitRunner } from "./git/runner.ts";
import {
	buildGitUiState,
	collectGitRawStatus,
	emptyGitUiState,
} from "./git/status-model.ts";
import { GitTuiComponent, GitTuiController } from "./git/tui.ts";
import type { NestedModel } from "./github/nested-agent.ts";
import { createGhRunner } from "./github/runner.ts";
import { COMMIT_DEFAULTS, loadConfig } from "./shared/config.ts";
import {
	type CollectDoctorOptions,
	collectDoctorReport,
	formatDoctorReport,
} from "./shared/doctor.ts";

export function getCliAgentDir(): string {
	return getAgentDir();
}

export function resolveCliConfig(cwd: string) {
	return loadConfig({
		agentDir: getCliAgentDir(),
		cwd,
		env: process.env,
		projectTrusted: false,
	});
}

export async function runDoctorCommand(
	options: CollectDoctorOptions,
	writeOutput: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
	const report = await collectDoctorReport(options);
	writeOutput(`${formatDoctorReport(report)}\n`);
	return 0;
}
export const USAGE = `pi-omp-git — OMP Git/GitHub parity for Pi

Usage:
  pi-omp-git git [revision] [-C <dir>]   Interactive Git TUI (requires a TTY)
  pi-omp-git commit [options]            Agentic commit pipeline
  pi-omp-git doctor                     Local environment diagnostics

Commit options:
  --all             Stage and commit all tracked modifications, deletions,
                    and untracked files (default: staged changes only)
  --push            Push after commits succeed
  --dry-run         Print the plan; commit and push nothing
  --no-changelog    Skip the changelog integration
  --context <text>  Extra context for the commit agent
  --model <model>   Model for the commit agent (default: configured default)
  -C <dir>          Run in <dir>
`;

interface ParsedArgs {
	revision?: string;
	dir?: string;
	push: boolean;
	dryRun: boolean;
	all: boolean;
	noChangelog: boolean;
	context?: string;
	model?: string;
}

export function parseCliArgs(args: string[]): ParsedArgs {
	const parsed: ParsedArgs = {
		push: false,
		dryRun: false,
		all: false,
		noChangelog: false,
	};
	const positional: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === undefined) continue;
		if (token === "-C") {
			const value = args[index + 1];
			if (value === undefined) {
				throw new Error("-C requires a directory argument");
			}
			parsed.dir = value;
			index += 1;
		} else if (token === "--push") {
			parsed.push = true;
		} else if (token === "--all") {
			parsed.all = true;
		} else if (token === "--dry-run") {
			parsed.dryRun = true;
		} else if (token === "--no-changelog") {
			parsed.noChangelog = true;
		} else if (token === "--context") {
			const value = args[index + 1];
			if (value === undefined) {
				throw new Error("--context requires a value");
			}
			parsed.context = value;
			index += 1;
		} else if (token === "--model") {
			const value = args[index + 1];
			if (value === undefined) {
				throw new Error("--model requires a value");
			}
			parsed.model = value;
			index += 1;
		} else if (token.startsWith("--context=")) {
			parsed.context = token.slice("--context=".length);
		} else if (token.startsWith("--model=")) {
			parsed.model = token.slice("--model=".length);
		} else if (token.startsWith("-")) {
			throw new Error(`Unknown option: ${token}`);
		} else {
			positional.push(token);
		}
	}
	if (positional.length > 1) {
		throw new Error(`Unexpected arguments: ${positional.slice(1).join(" ")}`);
	}
	const first = positional[0];
	if (first !== undefined) parsed.revision = first;
	return parsed;
}

/** `pi-omp-git git` — the standalone Git TUI (§60). */
export async function runGitCommand(
	args: string[],
	stdio: { isTTY: boolean },
): Promise<number> {
	const parsed = parseCliArgs(args);
	const cwd = parsed.dir ?? process.cwd();
	const git = createGitRunner({});

	// Resolve the repository state first so bad arguments fail fast
	// regardless of the terminal (§67 revision mode / ticket 17 states).
	let controller: GitTuiController;
	if (parsed.revision) {
		const info = await resolveRevision({ git }, cwd, parsed.revision);
		const revisionState = await collectRevisionStatus({ git }, cwd, info);
		controller = new GitTuiController(
			{ git, cwd },
			emptyGitUiState(revisionState.root),
			revisionState,
		);
	} else {
		const raw = await collectGitRawStatus({ git }, cwd);
		const initialState = buildGitUiState(raw);
		controller = new GitTuiController({ git, cwd }, initialState);
	}

	if (!stdio.isTTY) {
		process.stderr.write(
			"pi-omp-git git requires an interactive TTY — it cannot run without a terminal.\n",
		);
		return 1;
	}

	// The binary creates its own terminal renderer with the same
	// @earendil-works/pi-tui component library, so rendering matches the
	// in-Pi experience (§60).
	const agentDir = getCliAgentDir();
	const tui = new TuiMainScreen(new ProcessTerminal(), false, agentDir);
	let settled = false;
	return await new Promise<number>((resolve) => {
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			try {
				tui.stop();
			} catch {
				// stopping twice is harmless
			}
			resolve(code);
		};
		const component = new GitTuiComponent(tui, controller, () => finish(0), {
			height: process.stdout.rows ?? 30,
		});
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		tui.requestRender();
	});
}

/**
 * CLI commit arguments: the CLI-only `-C <dir>` is extracted first, then
 * the remaining tokens go through the shared strict commit-option parser
 * (§73) so both hosts reject the same invalid forms.
 */
export function parseCommitCliArgs(args: string[]): {
	dir?: string;
	options: CommitArgs;
} {
	const dirs: string[] = [];
	const commitTokens: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === undefined) continue;
		if (token === "-C") {
			const value = args[index + 1];
			if (value === undefined) {
				throw new Error("-C requires a directory argument");
			}
			dirs.push(value);
			index += 1;
			continue;
		}
		commitTokens.push(token);
	}
	if (dirs.length > 1) {
		throw new Error("-C was given more than once.");
	}
	return {
		...(dirs[0] !== undefined ? { dir: dirs[0] } : {}),
		options: parseCommitTokens(commitTokens),
	};
}

/** `pi-omp-git commit` — the standalone agentic commit pipeline (§73). */
export async function runCommitCommand(args: string[]): Promise<number> {
	const { dir, options: parsed } = parseCommitCliArgs(args);
	const cwd = dir ?? process.cwd();
	const config = resolveCliConfig(cwd);
	if (parsed.push && !config.github.enabled) {
		throw new Error(
			"GitHub integration is disabled by configuration; --push requires GitHub integration.",
		);
	}
	const settings = config.commit;
	const model = parsed.model
		? await resolveStandaloneModel(parsed.model)
		: undefined;
	const result = await runCommitPipeline(
		{
			git: createGitRunner({}),
			gh: createGhRunner({}),
			cwd,
			...(model ? { model } : {}),
			settings: {
				splitPolicy: settings.splitPolicy ?? COMMIT_DEFAULTS.splitPolicy,
				analyzeFilesEnabled:
					settings.analyzeFilesEnabled ?? COMMIT_DEFAULTS.analyzeFilesEnabled,
				analyzeFilesMaxFiles:
					settings.analyzeFilesMaxFiles ?? COMMIT_DEFAULTS.analyzeFilesMaxFiles,
				analyzeFilesMaxConcurrency:
					settings.analyzeFilesMaxConcurrency ??
					COMMIT_DEFAULTS.analyzeFilesMaxConcurrency,
				changelog: settings.changelog ?? COMMIT_DEFAULTS.changelog,
				changelogMaxDiffChars:
					settings.changelogMaxDiffChars ??
					COMMIT_DEFAULTS.changelogMaxDiffChars,
				dryRunAnalyzeFiles:
					settings.dryRunAnalyzeFiles ?? COMMIT_DEFAULTS.dryRunAnalyzeFiles,
			},
		},
		{
			...(parsed.dryRun ? { dryRun: true } : {}),
			...(parsed.push ? { push: true } : {}),
			...(parsed.all ? { all: true } : {}),
			...(parsed.noChangelog ? { noChangelog: true } : {}),
			...(parsed.context ? { context: parsed.context } : {}),
			// Noninteractive host: splitPolicy `confirm` fails explicitly
			// inside the pipeline rather than depending on TTY detection.
		},
	);
	process.stdout.write(`${result.text}\n`);
	// "committed", "dry-run", and the definitive "no-changes" outcome are
	// all successful pipeline results (§83's outcome C).
	return 0;
}

/** Resolve `--model` against the standalone model registry. */
async function resolveStandaloneModel(requested: string): Promise<NestedModel> {
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	const registry = new ModelRegistry(runtime);
	await registry.refresh();
	const wanted = requested.toLowerCase();
	const candidates = registry.getAll();
	const direct = candidates.find((model) => model.id.toLowerCase() === wanted);
	const found =
		direct ??
		candidates.find(
			(model) => `${model.provider}/${model.id}`.toLowerCase() === wanted,
		);
	if (!found) {
		throw new Error(
			`Unknown model: ${requested}. Use a model id (or provider/id) from the configured catalogue.`,
		);
	}
	return found;
}

/** CLI entry point. Returns the process exit code. */
export async function cliMain(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === undefined || command === "--help" || command === "-h") {
		process.stdout.write(USAGE);
		return 0;
	}
	try {
		if (command === "git")
			return await runGitCommand(rest, {
				isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
			});
		if (command === "doctor") {
			if (rest.length > 0) {
				process.stderr.write("The doctor command does not accept arguments.\n");
				return 1;
			}
			return await runDoctorCommand({
				agentDir: getCliAgentDir(),
				cwd: process.cwd(),
				env: process.env,
				projectTrusted: false,
			});
		}
		if (command === "commit") return await runCommitCommand(rest);
		process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
		return 1;
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
}
