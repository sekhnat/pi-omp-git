/**
 * pi-omp-git extension entry — tickets 01–03 and 08. The `read` override
 * routes virtual GitHub URIs through the cache; everything else delegates
 * to Pi's native read with zero behavior change. The `github` dispatcher
 * tool serves repo_view and file_read (later tickets activate the rest of
 * the §18 surface). No processes start at load; probes and the cache
 * database open lazily on first use.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { createGitRunner, type GitRunner } from "./git/runner.ts";
import {
	type Availability,
	createAvailability,
} from "./github/availability.ts";
import { credentialFingerprint } from "./github/cache/auth-key.ts";
import { createGithubCache, type GithubCache } from "./github/cache/cache.ts";
import { openCacheStore } from "./github/cache/db.ts";
import { createGithubTool } from "./github/dispatcher.ts";
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
	const githubTool = createGithubTool({
		gh,
		git,
		availability,
		env: process.env,
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

	// `github` dispatcher (ticket 08): repo_view and file_read now; the rest
	// of the §18 surface arrives in later tickets with clear errors meanwhile.
	pi.registerTool(ctx.githubTool);

	// Prompt guidance (§59) rides the system-prompt build hook so the agent
	// prefers these surfaces over curl/wget and scraping — appended as
	// guideline bullets, never a rewritten prompt.
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.promptGuidelines.push(
			...GITHUB_PROMPT_GUIDELINES,
		);
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
