/**
 * everything else delegates to Pi's native read with zero behavior
 * change. Delegation follows Pi's built-in-tool-renderer pattern: the
 * native read instance is created with the load cwd and receives
 * four-argument execute calls.
 * Nothing else registers model-facing surface yet (the `github` tool
 * arrives in ticket 08). No processes start at load; availability
 * probes run lazily.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import {
	type Availability,
	createAvailability,
} from "./github/availability.ts";
import {
	createGithubReadOverride,
	type GithubReadOverride,
} from "./github/resources/router.ts";
import { createGhRunner, type GhRunner } from "./github/runner.ts";
import type { Runner } from "./shared/subprocess.ts";
import { createRunner } from "./shared/subprocess.ts";

/** Session-scoped wiring later tickets build on. */
export interface OmpGitContext {
	runner: Runner;
	gh: GhRunner;
	availability: Availability;
	nativeRead: ReturnType<typeof createReadTool>;
	readOverride: GithubReadOverride;
}

export function createOmpGitContext(cwd?: string): OmpGitContext {
	const runner = createRunner();
	const gh = createGhRunner({ exec: undefined, cwd });
	const availability = createAvailability(runner);
	const nativeRead = createReadTool(cwd ?? process.cwd());
	const readOverride = createGithubReadOverride({
		gh,
		availability,
		nativeRead,
	});
	return { runner, gh, availability, nativeRead, readOverride };
}

export default function piOmpGitExtension(pi: ExtensionAPI): void {
	const ctx = createOmpGitContext();

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
