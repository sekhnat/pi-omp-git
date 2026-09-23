/**
 * pi-omp-git extension entry — ticket 01 lands the loadable package
 * skeleton. Nothing model-facing registers yet (the `read` override lands
 * in ticket 02, the `github` dispatcher in ticket 08). No processes are
 * started at load; availability probes run lazily.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Availability,
	createAvailability,
} from "./github/availability.ts";
import type { Runner } from "./shared/subprocess.ts";
import { createRunner } from "./shared/subprocess.ts";

/** Session-scoped wiring later tickets build on. */
export interface OmpGitContext {
	runner: Runner;
	availability: Availability;
}

export function createOmpGitContext(): OmpGitContext {
	const runner = createRunner();
	return { runner, availability: createAvailability(runner) };
}

export default function piOmpGitExtension(pi: ExtensionAPI): void {
	const ctx = createOmpGitContext();

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
