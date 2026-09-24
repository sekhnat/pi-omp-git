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

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";
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
import { loadConfig, type ResolvedConfig } from "./shared/config.ts";
import type { Runner } from "./shared/subprocess.ts";
import { createRunner } from "./shared/subprocess.ts";

/** Session-scoped wiring later tickets build on. */
export interface OmpGitContext {
	runner: Runner;
	gh: GhRunner;
	git: GitRunner;
	availability: Availability;
	cache: GithubCache;
	getConfig: () => ResolvedConfig;
	nativeRead: ReturnType<typeof createReadTool>;
	readOverride: GithubReadOverride;
	githubTool: ReturnType<typeof createGithubTool>;
	/** Invalidates cached rows for observed mutating `gh` commands (§57). */
	observeCommand: (command: string) => Promise<number>;
	setProjectTrusted(trusted: boolean): void;
}

export function createOmpGitContext(cwd?: string): OmpGitContext {
	const projectDir = cwd ?? process.cwd();
	const agentDir = join(homedir(), ".pi", "agent");
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
		getSettings: () => getConfig().github.cache,
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
		cache,
		getWorktreeRoot: () => getConfig().worktreeRoot,
		getArtifactsRoot: () => getConfig().artifactsRoot,
		mutationLock,
	});
	const commandObserver = createGhMutationInvalidator({
		cache,
		env: process.env,
		git,
	});
	return {
		runner,
		gh,
		git,
		availability,
		cache,
		getConfig,
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
	// Project configuration is read only after project trust is granted
	// (ticket 03); trust is resolved by the time a session starts.
	pi.on("session_start", (_event, sessionCtx) => {
		ctx.setProjectTrusted(sessionCtx.isProjectTrusted());
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

	pi.registerCommand("omp-git-doctor", {
		description: "Report git and gh availability for pi-omp-git",
		handler: async (_args, commandCtx) => {
			const [git, gh] = await Promise.all([
				ctx.availability.git(),
				ctx.availability.gh(),
			]);
			const lines = [
				`pi-omp-git doctor`,
				`git: ${git.ok ? "available" : git.message}`,
				`gh: ${gh.ok ? "available" : gh.message}`,
			];
			commandCtx.ui.notify(lines.join("\n"), "info");
		},
	});
}
