/**
 * Dependency gating — availability probes for `gh` and `git`
 * (docs/pi-omp-git-reference.md §4). Probes are memoized per availability
 * instance so repeated surfaces do not re-probe; `reset()` re-probes.
 *
 * When `gh` is missing or unauthenticated, Git functionality keeps
 * working; GitHub surfaces return the stable friendly errors via
 * `ensureAvailable` (src/shared/errors.ts).
 */

import { ensureAvailable, FRIENDLY_ERRORS } from "../shared/errors.ts";
import { CommandNotFoundError, type Runner } from "../shared/subprocess.ts";

export type GhAvailability =
	| { ok: true }
	| { ok: false; reason: "missing" | "unauthenticated"; message: string };

export type GitAvailability =
	| { ok: true }
	| { ok: false; reason: "missing"; message: string };

export interface Availability {
	/** Memoized `gh` availability probe. */
	gh(): Promise<GhAvailability>;
	/** Memoized `git` availability probe. */
	git(): Promise<GitAvailability>;
	/** Discard memoized probes so the next call re-probes. */
	reset(): void;
	/** Throw the friendly dependency/auth error unless gh is usable. */
	ensureGh(): Promise<void>;
	/** Throw the friendly dependency error unless git is usable. */
	ensureGit(): Promise<void>;
}

export function createAvailability(runner: Runner): Availability {
	let ghProbe: Promise<GhAvailability> | undefined;
	let gitProbe: Promise<GitAvailability> | undefined;

	const probeGh = async (): Promise<GhAvailability> => {
		try {
			const version = await runner.run("gh", { args: ["--version"] });
			if (
				version.exitCode !== 0 ||
				!/^gh version/.test(version.stdout.trim())
			) {
				return {
					ok: false,
					reason: "missing",
					message: FRIENDLY_ERRORS.ghMissing,
				};
			}
			const auth = await runner.run("gh", { args: ["auth", "status"] });
			if (auth.exitCode !== 0) {
				return {
					ok: false,
					reason: "unauthenticated",
					message: FRIENDLY_ERRORS.ghUnauthenticated,
				};
			}
			return { ok: true };
		} catch (error) {
			if (error instanceof CommandNotFoundError) {
				return {
					ok: false,
					reason: "missing",
					message: FRIENDLY_ERRORS.ghMissing,
				};
			}
			throw error;
		}
	};

	const probeGit = async (): Promise<GitAvailability> => {
		try {
			const version = await runner.run("git", { args: ["--version"] });
			if (
				version.exitCode !== 0 ||
				!/^git version/.test(version.stdout.trim())
			) {
				return {
					ok: false,
					reason: "missing",
					message: FRIENDLY_ERRORS.gitMissing,
				};
			}
			return { ok: true };
		} catch (error) {
			if (error instanceof CommandNotFoundError) {
				return {
					ok: false,
					reason: "missing",
					message: FRIENDLY_ERRORS.gitMissing,
				};
			}
			throw error;
		}
	};

	return {
		gh() {
			ghProbe ??= probeGh();
			return ghProbe;
		},
		git() {
			gitProbe ??= probeGit();
			return gitProbe;
		},
		reset() {
			ghProbe = undefined;
			gitProbe = undefined;
		},
		async ensureGh() {
			ensureAvailable(await this.gh(), "gh");
		},
		async ensureGit() {
			ensureAvailable(await this.git(), "git");
		},
	};
}
