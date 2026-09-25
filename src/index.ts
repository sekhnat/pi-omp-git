/**
 * pi-omp-git extension entry — tickets 01–04 and 08–14. The `read`
 * override routes virtual GitHub URIs through the cache; everything else
 * delegates to Pi's native read with zero behavior change. The `github`
 * dispatcher tool serves repo_view, file_read, pr_create, pr_checkout,
 * pr_push, and the searches (§18). After each checkout the session
 * records the last-checkout entry `pr_push` and `run_watch` resolve by
 * (§110); `gh` mutations observed in bash commands invalidate cache rows
 * before execution (§57). No processes start at load; probes and the
 * cache database open lazily on first use.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createReadTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type CommitArgs, parseCommitArgs } from "./git/commit-args.ts";
import { runCommitPipeline } from "./git/commit-pipeline.ts";
import { createMutationLock } from "./git/mutation-lock.ts";
import { collectRevisionStatus, resolveRevision } from "./git/revision.ts";
import { createGitRunner, type GitRunner } from "./git/runner.ts";
import {
	buildGitUiState,
	collectGitRawStatus,
	emptyGitUiState,
} from "./git/status-model.ts";
import { GitTuiComponent, GitTuiController } from "./git/tui.ts";
import {
	type Availability,
	createAvailability,
} from "./github/availability.ts";
import { credentialFingerprint } from "./github/cache/auth-key.ts";
import { createGithubCache, type GithubCache } from "./github/cache/cache.ts";
import { openCacheStore } from "./github/cache/db.ts";
import {
	createGithubTool,
	type GithubToolDetails,
} from "./github/dispatcher.ts";
import { createGhMutationInvalidator } from "./github/invalidation.ts";
import {
	CHECKOUT_ENTRY_TYPE,
	findLastCheckout,
} from "./github/last-checkout.ts";
import { GITHUB_PROMPT_GUIDELINES } from "./github/prompt-guidelines.ts";
import {
	createGithubReadOverride,
	type GithubReadOverride,
} from "./github/resources/router.ts";
import { createGhRunner, type GhRunner } from "./github/runner.ts";
import {
	COMMIT_DEFAULTS,
	loadConfig,
	type ResolvedConfig,
} from "./shared/config.ts";
import { collectDoctorReport, formatDoctorReport } from "./shared/doctor.ts";
import type { Runner } from "./shared/subprocess.ts";
import { createRunner } from "./shared/subprocess.ts";

/** Session-scoped wiring later tickets build on. */
export interface OmpGitContext {
	runner: Runner;
	agentDir: string;
	cwd: string;
	gh: GhRunner;
	git: GitRunner;
	availability: Availability;
	cache: GithubCache;
	getConfig: () => ResolvedConfig;
	getProjectTrusted(): boolean;
	nativeRead: ReturnType<typeof createReadTool>;
	readOverride: GithubReadOverride;
	githubTool: ReturnType<typeof createGithubTool>;
	/** Invalidates cached rows for observed mutating `gh` commands (§57). */
	observeCommand: (command: string) => Promise<number>;
	setProjectTrusted(trusted: boolean): void;
}

export function createOmpGitContext(cwd?: string): OmpGitContext {
	const projectDir = cwd ?? process.cwd();
	const agentDir = getAgentDir();
	const runner = createRunner();
	const gh = createGhRunner({ exec: undefined, cwd: projectDir });
	const git = createGitRunner({ exec: undefined, cwd: projectDir });
	const availability = createAvailability(runner);

	// The project configuration file is read only after project trust is
	// granted (ticket 03); trust is resolved by the time a session starts.
	let projectTrusted = false;
	const getConfig = (): ResolvedConfig =>
		loadConfig({ agentDir, cwd: projectDir, env: process.env, projectTrusted });

	const cache = createGithubCache({
		getStore: () => openCacheStore(getConfig().cacheDatabasePath),
		getSettings: () => {
			const config = getConfig();
			return {
				...config.github.cache,
				enabled: config.github.enabled && config.github.cache.enabled,
			};
		},
		authKey: () => credentialFingerprint(process.env),
	});
	const nativeRead = createReadTool(projectDir);
	const readOverride = createGithubReadOverride({
		gh,
		git,
		availability,
		cache,
		env: process.env,
		getConfig,
		nativeRead,
	});
	const mutationLock = createMutationLock();
	const githubTool = createGithubTool({
		gh,
		git,
		availability,
		env: process.env,
		githubEnabled: () => getConfig().github.enabled,
		cache,
		getWorktreeRoot: () => getConfig().worktreeRoot,
		getArtifactsRoot: () => getConfig().artifactsRoot,
		mutationLock,
	});
	const commandObserver = createGhMutationInvalidator({
		cache,
		env: process.env,
		githubEnabled: () => getConfig().github.enabled,
		git,
	});
	return {
		runner,
		gh,
		agentDir,
		cwd: projectDir,
		git,
		availability,
		cache,
		getConfig,
		getProjectTrusted: () => projectTrusted,
		nativeRead,
		readOverride,
		githubTool,
		observeCommand: (command) => commandObserver.observe(command),
		setProjectTrusted: (trusted: boolean): void => {
			projectTrusted = trusted;
		},
	};
}

export default function piOmpGitExtension(pi: ExtensionAPI): void {
	const ctx = createOmpGitContext();
	let githubToolInitiallyActive: boolean | undefined;
	const syncGithubToolActivation = (): void => {
		const activeTools = pi.getActiveTools();
		githubToolInitiallyActive ??= activeTools.includes("github");
		const shouldBeActive =
			ctx.getConfig().github.enabled && githubToolInitiallyActive;
		const nextTools = shouldBeActive
			? activeTools.includes("github")
				? activeTools
				: [...activeTools, "github"]
			: activeTools.filter((name) => name !== "github");
		if (
			nextTools.length !== activeTools.length ||
			nextTools.some((name, index) => name !== activeTools[index])
		) {
			pi.setActiveTools(nextTools);
		}
	};
	// Project configuration is read only after project trust is granted
	// (ticket 03); trust is resolved by the time a session starts.
	pi.on("session_start", (_event, sessionCtx) => {
		ctx.setProjectTrusted(sessionCtx.isProjectTrusted());
		syncGithubToolActivation();
	});

	// `read` override (ticket 02): virtual GitHub URIs render; every other
	// path delegates to Pi's native read with zero behavior change.
	pi.registerTool({
		name: "read",
		label: "read",
		description: ctx.nativeRead.description,
		parameters: ctx.nativeRead.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return ctx.readOverride.execute(toolCallId, params, signal, onUpdate);
		},
	});

	// `github` dispatcher (§18): after each successful checkout the session
	// records the checkout that pr_push and run_watch resolve by (§110) —
	// the record is derived from the transcript, so it survives resume.
	pi.registerTool({
		...ctx.githubTool,
		async execute(toolCallId, params, signal, onUpdate, extCtx) {
			const result = await ctx.githubTool.execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				{
					model: extCtx?.model,
					cwd: extCtx?.cwd,
					getLastCheckout: extCtx?.sessionManager
						? () => findLastCheckout(extCtx.sessionManager.getBranch())
						: undefined,
				},
			);
			const details = result.details as GithubToolDetails | undefined;
			if (details?.op === "pr_checkout" && details.checkouts) {
				for (const record of details.checkouts) {
					pi.appendEntry(CHECKOUT_ENTRY_TYPE, {
						pr: record.pr,
						number: record.number,
						...(record.url ? { url: record.url } : {}),
						branch: record.branch,
						worktreePath: record.worktreePath,
						at: Date.now(),
					});
				}
			}
			return result;
		},
	});

	// Shell `gh` mutation invalidation (§57): observed bash tool calls and
	// interactive `!` commands invalidate relevant cache rows BEFORE the
	// command executes — detection, not success; over-invalidation beats
	// staleness (§58). Parsing is heuristic and never executes the command.
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || command === "") return;
		await ctx.observeCommand(command);
	});
	pi.on("user_bash", async (event) => {
		if (event.command) await ctx.observeCommand(event.command);
	});

	// Prompt guidance (§59) rides the system-prompt build hook so the agent
	// prefers these surfaces over curl/wget and scraping — appended as
	// guideline bullets, never a rewritten prompt.
	pi.on("before_agent_start", (event) => {
		syncGithubToolActivation();
		if (
			!ctx.getConfig().github.enabled ||
			!pi.getActiveTools().includes("github")
		) {
			return;
		}
		event.systemPromptOptions.promptGuidelines.push(
			...GITHUB_PROMPT_GUIDELINES,
		);
	});

	// `/git` (§60–§66): interactive Git TUI over the headless state model.
	pi.registerCommand("git", {
		description:
			"Interactive Git TUI — status, diffs, stage/unstage/discard; /git <revision> inspects a commit read-only",
		handler: async (args, commandCtx) => {
			if (commandCtx.mode !== "tui") {
				commandCtx.ui.notify(
					"/git requires an interactive terminal — it cannot open in RPC, JSON, or print mode.",
					"error",
				);
				return;
			}
			const cwd = commandCtx.cwd;
			try {
				await ctx.availability.git();
			} catch (error) {
				commandCtx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
				return;
			}
			const revisionRef = (args ?? "").trim();
			let controller: GitTuiController;
			try {
				if (revisionRef) {
					// Revision mode (§67): read-only inspection of one commit.
					const info = await resolveRevision(
						{ git: ctx.git },
						cwd,
						revisionRef,
					);
					const revisionState = await collectRevisionStatus(
						{ git: ctx.git },
						cwd,
						info,
					);
					controller = new GitTuiController(
						{ git: ctx.git, cwd },
						emptyGitUiState(cwd),
						revisionState,
					);
				} else {
					const raw = await collectGitRawStatus({ git: ctx.git }, cwd);
					const initialState = buildGitUiState(raw);
					controller = new GitTuiController(
						{
							git: ctx.git,
							cwd,
							model: commandCtx.model,
						},
						initialState,
					);
				}
			} catch (error) {
				commandCtx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
				return;
			}
			await commandCtx.ui.custom((tui, _theme, _keybindings, done) => {
				return new GitTuiComponent(tui, controller, () => done(undefined), {
					height: 30,
				});
			});
		},
	});

	pi.registerCommand("commit", {
		description:
			"Agentic commit pipeline — plans, proposes, and executes commits (--all, --dry-run, --push, --no-changelog, --context, --model)",
		handler: async (args, commandCtx) => {
			// Argument errors are reported in the UI before any repository work.
			const parsed = parseCommitArgsSafely(args ?? "");
			if (!parsed.ok) {
				commandCtx.ui.notify(parsed.message, "error");
				return;
			}
			const options = parsed.options;
			const config = ctx.getConfig();
			const settings = config.commit;
			// §78: split plans under `confirm` need the interactive dialog.
			const confirmPlan =
				settings.splitPolicy === "confirm" && commandCtx.hasUI
					? (plan: string) =>
							commandCtx.ui.confirm("Apply this commit plan?", plan)
					: undefined;
			try {
				if (options.push && !config.github.enabled) {
					throw new Error(
						"GitHub integration is disabled by configuration; --push requires GitHub integration.",
					);
				}
				await ctx.availability.git();
				const model = await resolveCommitModel(options.model, commandCtx);
				const result = await runCommitPipeline(
					{
						git: ctx.git,
						gh: ctx.gh,
						cwd: commandCtx.cwd,
						model,
						signal: commandCtx.signal,
						settings: {
							splitPolicy: settings.splitPolicy ?? COMMIT_DEFAULTS.splitPolicy,
							analyzeFilesEnabled:
								settings.analyzeFilesEnabled ??
								COMMIT_DEFAULTS.analyzeFilesEnabled,
							analyzeFilesMaxFiles:
								settings.analyzeFilesMaxFiles ??
								COMMIT_DEFAULTS.analyzeFilesMaxFiles,
							analyzeFilesMaxConcurrency:
								settings.analyzeFilesMaxConcurrency ??
								COMMIT_DEFAULTS.analyzeFilesMaxConcurrency,
							changelog: settings.changelog ?? COMMIT_DEFAULTS.changelog,
							changelogMaxDiffChars:
								settings.changelogMaxDiffChars ??
								COMMIT_DEFAULTS.changelogMaxDiffChars,
							dryRunAnalyzeFiles:
								settings.dryRunAnalyzeFiles ??
								COMMIT_DEFAULTS.dryRunAnalyzeFiles,
						},
					},
					{
						...(options.dryRun ? { dryRun: true } : {}),
						...(options.push ? { push: true } : {}),
						...(options.all ? { all: true } : {}),
						...(options.noChangelog ? { noChangelog: true } : {}),
						...(options.context ? { context: options.context } : {}),
						...(confirmPlan ? { confirmPlan } : {}),
					},
				);
				commandCtx.ui.notify(result.text, "info");
			} catch (error) {
				commandCtx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});

	pi.registerCommand("omp-git-doctor", {
		description:
			"Report local Git, GitHub, configuration, and path diagnostics",
		handler: async (_args, commandCtx) => {
			const report = await collectDoctorReport({
				agentDir: ctx.agentDir,
				cwd: ctx.cwd,
				env: process.env,
				projectTrusted: ctx.getProjectTrusted(),
				runner: ctx.runner,
			});
			commandCtx.ui.notify(formatDoctorReport(report), "info");
		},
	});
}

export { parseCommitArgs };

/**
 * Parse `/commit` input (§73) without throwing, so argument errors are
 * reported as a UI-visible failure before any repository work.
 */
export function parseCommitArgsSafely(
	input: string,
): { ok: true; options: CommitArgs } | { ok: false; message: string } {
	try {
		return { ok: true, options: parseCommitArgs(input) };
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Resolve `--model` against the session's model registry; without it the
 * default is the current session's model (ADR 0004, §75).
 */
async function resolveCommitModel(
	requested: string | undefined,
	commandCtx: ExtensionCommandContext,
): Promise<ExtensionCommandContext["model"]> {
	if (!requested) return commandCtx.model;
	await commandCtx.modelRegistry.refresh();
	const wanted = requested.toLowerCase();
	const candidates = commandCtx.modelRegistry.getAll();
	const direct = candidates.find((model) => model.id.toLowerCase() === wanted);
	if (direct) return direct;
	const qualified = candidates.find(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === wanted,
	);
	if (qualified) return qualified;
	throw new Error(
		`Unknown model: ${requested}. Use a model id (or provider/id) known to this session.`,
	);
}
